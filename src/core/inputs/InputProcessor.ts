/**
 * InputProcessor - Handles downloading, transcribing, and extracting content from inputs.
 *
 * Operations:
 * - Download remote URLs
 * - Download YouTube content (video/audio)
 * - Transcribe audio with timestamps
 * - Extract keyframes from video
 * - Extract audio from video
 * - Validate local files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { getProjectDir } from '../../tasks/video/workflow/ProjectManager.js';
import * as http from 'http';
import { spawn } from 'child_process';
import type { InputMediaType, ProjectInput } from '../../tasks/video/workflow/types.js';
import { inputDetector } from './InputDetector.js';
import { getFfmpegPath, getFfprobePath } from '../timeline/ffmpegBinaries.js';

/**
 * Result of downloading remote content.
 */
export interface DownloadResult {
  /** Local path where content was saved */
  localPath: string;
  /** Metadata about the download */
  metadata: {
    /** Original URL */
    url: string;
    /** Content type from headers */
    contentType?: string;
    /** File size in bytes */
    size?: number;
    /** Filename from URL or headers */
    filename?: string;
  };
}

/**
 * Result of downloading YouTube content.
 */
export interface YouTubeDownloadResult {
  /** Path to downloaded video (if requested) */
  videoPath?: string;
  /** Path to downloaded audio (if requested) */
  audioPath?: string;
  /** Video metadata */
  metadata: {
    /** Video title */
    title: string;
    /** Duration in seconds */
    duration: number;
    /** Thumbnail URL */
    thumbnail?: string;
    /** Video ID */
    videoId: string;
  };
}

/**
 * Result of audio transcription.
 */
export interface TranscriptionResult {
  /** Full transcription text */
  text: string;
  /** Segments with timestamps */
  segments: Array<{
    /** Start time in seconds */
    start: number;
    /** End time in seconds */
    end: number;
    /** Text content */
    text: string;
  }>;
}

/**
 * Result of local path validation.
 */
export interface ValidationResult {
  /** Whether the file exists */
  exists: boolean;
  /** Detected media type */
  mediaType: InputMediaType | null;
  /** File metadata */
  metadata: {
    /** File size in bytes */
    size?: number;
    /** MIME type if detectable */
    mimeType?: string;
    /** File extension */
    extension?: string;
  };
}

/**
 * Configuration for the input processor.
 */
export interface InputProcessorConfig {
  /** Base directory for storing processed inputs */
  inputsDir: string;
  /** Path to yt-dlp binary (default: 'yt-dlp') */
  ytDlpPath?: string;
  /** Path to ffmpeg binary (default: 'ffmpeg') */
  ffmpegPath?: string;
  /** Path to ffprobe binary (default: 'ffprobe') */
  ffprobePath?: string;
  /** Whisper API endpoint for transcription (optional) */
  whisperEndpoint?: string;
}

/**
 * Default configuration. ffmpeg/ffprobe paths resolve at construction
 * time so the desktop wrapper can set dhee_FFMPEG_PATH /
 * dhee_FFPROBE_PATH after dhee-core has loaded.
 */
function buildDefaultConfig(): InputProcessorConfig {
  return {
    inputsDir: 'inputs',
    ytDlpPath: 'yt-dlp',
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
  };
}

/**
 * InputProcessor class for handling input processing operations.
 */
export class InputProcessor {
  private config: InputProcessorConfig;

  constructor(config: Partial<InputProcessorConfig> = {}) {
    this.config = { ...buildDefaultConfig(), ...config };
  }

  /**
   * Process a ProjectInput - download, transcribe, extract as needed.
   */
  async process(input: ProjectInput): Promise<ProjectInput> {
    const updated = { ...input };
    updated.processing = { ...input.processing, status: 'processing' };

    try {
      // Handle based on source type
      switch (input.source.type) {
        case 'local_path':
          await this.processLocalPath(updated);
          break;

        case 'remote_url':
          await this.processRemoteUrl(updated);
          break;

        case 'youtube':
          await this.processYouTube(updated);
          break;

        case 'inline':
          await this.processInline(updated);
          break;
      }

      // Additional processing based on media type and purpose
      await this.processMediaSpecific(updated);

      updated.processing.status = 'completed';
      updated.metadata.processedAt = Date.now();
    } catch (error) {
      updated.processing.status = 'failed';
      updated.processing.error = error instanceof Error ? error.message : String(error);
    }

    return updated;
  }

  /**
   * Process a local file path.
   */
  private async processLocalPath(input: ProjectInput): Promise<void> {
    const sourcePath = input.source.value;
    const validation = await this.validateLocalPath(sourcePath);

    if (!validation.exists) {
      throw new Error(`Local file not found: ${sourcePath}`);
    }

    // Copy to inputs directory for consistency
    const inputsDir = this.ensureInputsDir('local');
    const filename = path.basename(sourcePath);
    const destPath = path.join(inputsDir, `${input.id}-${filename}`);

    await fs.promises.copyFile(sourcePath, destPath);
    input.processing.localPath = destPath;

    if (validation.metadata.size) {
      input.metadata.fileSize = validation.metadata.size;
    }
    if (validation.metadata.mimeType) {
      input.metadata.mimeType = validation.metadata.mimeType;
    }
    input.metadata.originalFilename = filename;
  }

  /**
   * Process a remote URL.
   */
  private async processRemoteUrl(input: ProjectInput): Promise<void> {
    const url = input.source.value;
    const inputsDir = this.ensureInputsDir('remote');

    const result = await this.downloadRemote(url, input.mediaType);

    // Move to final location
    const filename = result.metadata.filename || `${input.id}.${this.getExtensionForMediaType(input.mediaType)}`;
    const destPath = path.join(inputsDir, filename);

    await fs.promises.rename(result.localPath, destPath);
    input.processing.localPath = destPath;

    if (result.metadata.size) {
      input.metadata.fileSize = result.metadata.size;
    }
    if (result.metadata.contentType) {
      input.metadata.mimeType = result.metadata.contentType;
    }
    input.metadata.originalFilename = filename;
  }

  /**
   * Process a YouTube URL.
   */
  private async processYouTube(input: ProjectInput): Promise<void> {
    const youtubeId = input.metadata.youtubeId;
    if (!youtubeId) {
      throw new Error('YouTube ID not found in input metadata');
    }

    const inputsDir = this.ensureInputsDir('youtube');

    // Determine what to download based on purpose
    let format: 'audio' | 'video' | 'both' = 'video';
    if (input.purpose === 'narration' || input.purpose === 'background_music') {
      format = 'audio';
    } else if (input.purpose === 'anchor_video') {
      format = 'both'; // Need both video and audio for anchor
    }

    const result = await this.downloadYouTube(`https://youtube.com/watch?v=${youtubeId}`, {
      format,
      outputDir: inputsDir,
      prefix: input.id,
    });

    input.processing.localPath = result.videoPath || result.audioPath;
    if (result.audioPath && result.audioPath !== result.videoPath) {
      input.processing.extractedAudioPath = result.audioPath;
    }

    input.metadata.youtubeTitle = result.metadata.title;
    input.metadata.duration = result.metadata.duration;
  }

  /**
   * Process inline text content.
   */
  private async processInline(input: ProjectInput): Promise<void> {
    const inputsDir = this.ensureInputsDir('local');
    const filename = `${input.id}.txt`;
    const destPath = path.join(inputsDir, filename);

    await fs.promises.writeFile(destPath, input.source.value, 'utf-8');
    input.processing.localPath = destPath;
    input.metadata.originalFilename = filename;
    input.metadata.fileSize = Buffer.byteLength(input.source.value, 'utf-8');
  }

  /**
   * Process media-specific operations (transcription, keyframe extraction).
   */
  private async processMediaSpecific(input: ProjectInput): Promise<void> {
    const localPath = input.processing.localPath;
    if (!localPath) return;

    // Audio transcription for narration
    if (
      input.mediaType === 'audio' &&
      (input.purpose === 'narration' || input.purpose === 'background_music')
    ) {
      try {
        const transcription = await this.transcribeAudio(localPath);
        input.processing.transcription = transcription.text;
        input.processing.timingMarkers = transcription.segments;

        // Save transcription to file
        const transcriptionPath = localPath.replace(/\.[^.]+$/, '_transcription.json');
        await fs.promises.writeFile(
          transcriptionPath,
          JSON.stringify(transcription, null, 2),
          'utf-8'
        );
        input.processing.transcriptionPath = transcriptionPath;
      } catch (error) {
        // Transcription is optional - log but don't fail
        console.warn('Transcription failed:', error);
      }
    }

    // Video processing
    if (input.mediaType === 'video') {
      // Extract audio for narration purposes
      if (input.purpose === 'narration' || input.purpose === 'anchor_video') {
        if (!input.processing.extractedAudioPath) {
          try {
            const audioPath = await this.extractAudio(localPath);
            input.processing.extractedAudioPath = audioPath;

            // Transcribe the extracted audio
            const transcription = await this.transcribeAudio(audioPath);
            input.processing.transcription = transcription.text;
            input.processing.timingMarkers = transcription.segments;
          } catch (error) {
            console.warn('Audio extraction/transcription failed:', error);
          }
        }
      }

      // Extract keyframes for reference purposes
      if (
        input.purpose === 'style_ref' ||
        input.purpose === 'motion_ref' ||
        input.purpose === 'character_ref' ||
        input.purpose === 'setting_ref'
      ) {
        try {
          const keyframes = await this.extractKeyframes(localPath, 5);
          input.processing.keyframePaths = keyframes;
        } catch (error) {
          console.warn('Keyframe extraction failed:', error);
        }
      }

      // Get video duration if not already set
      if (!input.metadata.duration) {
        try {
          const duration = await this.getMediaDuration(localPath);
          input.metadata.duration = duration;
        } catch (error) {
          console.warn('Could not get video duration:', error);
        }
      }
    }
  }

  /**
   * Download content from a remote URL.
   */
  async downloadRemote(url: string, mediaType: InputMediaType): Promise<DownloadResult> {
    const tempDir = this.ensureInputsDir('temp');
    const tempPath = path.join(tempDir, `download-${Date.now()}`);

    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const request = protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadRemote(redirectUrl, mediaType).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        const contentType = response.headers['content-type'];
        const contentLength = response.headers['content-length'];

        // Determine filename
        const contentDisposition = response.headers['content-disposition'];
        let filename: string | undefined;
        if (contentDisposition) {
          const match = contentDisposition.match(/filename="?([^";\s]+)"?/);
          if (match) filename = match[1];
        }
        if (!filename) {
          filename = path.basename(new URL(url).pathname);
        }

        const writeStream = fs.createWriteStream(tempPath);
        response.pipe(writeStream);

        writeStream.on('finish', () => {
          resolve({
            localPath: tempPath,
            metadata: {
              url,
              contentType,
              size: contentLength ? parseInt(contentLength, 10) : undefined,
              filename,
            },
          });
        });

        writeStream.on('error', reject);
      });

      request.on('error', reject);
    });
  }

  /**
   * Download YouTube content using yt-dlp.
   */
  async downloadYouTube(
    url: string,
    options: {
      format: 'audio' | 'video' | 'both';
      quality?: 'low' | 'medium' | 'high';
      outputDir?: string;
      prefix?: string;
    } = { format: 'video' }
  ): Promise<YouTubeDownloadResult> {
    const outputDir = options.outputDir || this.ensureInputsDir('youtube');
    const prefix = options.prefix || Date.now().toString();

    // Check if yt-dlp is available
    const ytDlpAvailable = await this.checkCommand(this.config.ytDlpPath || 'yt-dlp');
    if (!ytDlpAvailable) {
      throw new Error(
        'yt-dlp is not installed. Please install it: brew install yt-dlp (macOS) or pip install yt-dlp'
      );
    }

    // Get video info first
    const infoArgs = ['--dump-json', '--no-download', url];
    const infoResult = await this.runCommand(this.config.ytDlpPath || 'yt-dlp', infoArgs);
    const info = JSON.parse(infoResult) as {
      id: string;
      title: string;
      duration: number;
      thumbnail?: string;
    };

    const result: YouTubeDownloadResult = {
      metadata: {
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        videoId: info.id,
      },
    };

    // Download based on format
    if (options.format === 'audio' || options.format === 'both') {
      const audioPath = path.join(outputDir, `${prefix}-audio.mp3`);
      const audioArgs = [
        '-x',
        '--audio-format',
        'mp3',
        '-o',
        audioPath,
        url,
      ];
      await this.runCommand(this.config.ytDlpPath || 'yt-dlp', audioArgs);
      result.audioPath = audioPath;
    }

    if (options.format === 'video' || options.format === 'both') {
      const quality = options.quality || 'medium';
      const formatSpec =
        quality === 'high'
          ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
          : quality === 'low'
            ? 'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst'
            : 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best';

      const videoPath = path.join(outputDir, `${prefix}-video.mp4`);
      const videoArgs = ['-f', formatSpec, '-o', videoPath, url];
      await this.runCommand(this.config.ytDlpPath || 'yt-dlp', videoArgs);
      result.videoPath = videoPath;
    }

    return result;
  }

  /**
   * Transcribe audio with timestamps.
   * Uses Whisper API if configured, otherwise falls back to mock data.
   */
  async transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
    // Check if audio file exists
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    // If Whisper endpoint is configured, use it
    if (this.config.whisperEndpoint) {
      return this.transcribeWithWhisper(audioPath);
    }

    // Fall back to mock transcription
    // In production, this would use a local Whisper model or API
    console.warn('No Whisper endpoint configured. Using placeholder transcription.');

    const duration = await this.getMediaDuration(audioPath);

    return {
      text: '[Transcription pending - Whisper API not configured]',
      segments: [
        {
          start: 0,
          end: duration,
          text: '[Full audio content]',
        },
      ],
    };
  }

  /**
   * Transcribe using Whisper API.
   */
  private async transcribeWithWhisper(audioPath: string): Promise<TranscriptionResult> {
    const endpoint = this.config.whisperEndpoint;
    if (!endpoint) {
      throw new Error('Whisper endpoint not configured');
    }

    // Read audio file
    const audioBuffer = await fs.promises.readFile(audioPath);

    // Create form data
    const boundary = `----FormBoundary${Date.now()}`;
    const formData = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${path.basename(audioPath)}"\r\n`),
      Buffer.from(`Content-Type: audio/mpeg\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="response_format"\r\n\r\n`),
      Buffer.from(`verbose_json`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    // Make request
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper API error: ${response.status}`);
    }

    const result = (await response.json()) as {
      text: string;
      segments: Array<{ start: number; end: number; text: string }>;
    };

    return {
      text: result.text,
      segments: result.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })),
    };
  }

  /**
   * Extract keyframes from a video.
   */
  async extractKeyframes(videoPath: string, count: number = 5): Promise<string[]> {
    // Check if ffmpeg is available
    const ffmpegAvailable = await this.checkCommand(this.config.ffmpegPath || 'ffmpeg');
    if (!ffmpegAvailable) {
      throw new Error('ffmpeg is not installed. Please install it: brew install ffmpeg');
    }

    const outputDir = this.ensureInputsDir('keyframes');
    const basename = path.basename(videoPath, path.extname(videoPath));
    const pattern = path.join(outputDir, `${basename}-keyframe-%03d.jpg`);

    // Get video duration
    const duration = await this.getMediaDuration(videoPath);
    const interval = duration / (count + 1);

    // Extract frames at regular intervals
    const args = [
      '-i',
      videoPath,
      '-vf',
      `fps=1/${interval}`,
      '-frames:v',
      count.toString(),
      '-q:v',
      '2',
      pattern,
    ];

    await this.runCommand(this.config.ffmpegPath || 'ffmpeg', args);

    // Find generated files
    const files: string[] = [];
    for (let i = 1; i <= count; i++) {
      const framePath = path.join(outputDir, `${basename}-keyframe-${String(i).padStart(3, '0')}.jpg`);
      if (fs.existsSync(framePath)) {
        files.push(framePath);
      }
    }

    return files;
  }

  /**
   * Extract audio from a video file.
   */
  async extractAudio(videoPath: string): Promise<string> {
    // Check if ffmpeg is available
    const ffmpegAvailable = await this.checkCommand(this.config.ffmpegPath || 'ffmpeg');
    if (!ffmpegAvailable) {
      throw new Error('ffmpeg is not installed. Please install it: brew install ffmpeg');
    }

    const outputDir = this.ensureInputsDir('extracted_audio');
    const basename = path.basename(videoPath, path.extname(videoPath));
    const outputPath = path.join(outputDir, `${basename}-audio.mp3`);

    const args = [
      '-i',
      videoPath,
      '-vn', // No video
      '-acodec',
      'libmp3lame',
      '-q:a',
      '2',
      '-y', // Overwrite
      outputPath,
    ];

    await this.runCommand(this.config.ffmpegPath || 'ffmpeg', args);

    return outputPath;
  }

  /**
   * Validate a local file path.
   */
  async validateLocalPath(inputPath: string): Promise<ValidationResult> {
    try {
      const resolved = path.resolve(inputPath);
      const stats = await fs.promises.stat(resolved);

      if (!stats.isFile()) {
        return { exists: false, mediaType: null, metadata: {} };
      }

      const extension = path.extname(resolved).toLowerCase().slice(1);
      const mediaType = inputDetector.detectMediaTypeFromExtension(extension);

      return {
        exists: true,
        mediaType,
        metadata: {
          size: stats.size,
          extension,
        },
      };
    } catch {
      return { exists: false, mediaType: null, metadata: {} };
    }
  }

  /**
   * Get media duration using ffprobe.
   */
  async getMediaDuration(filePath: string): Promise<number> {
    try {
      const ffprobeAvailable = await this.checkCommand(this.config.ffprobePath || 'ffprobe');
      if (!ffprobeAvailable) {
        return 0;
      }

      const args = [
        '-v',
        'quiet',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ];

      const result = await this.runCommand(this.config.ffprobePath || 'ffprobe', args);
      return parseFloat(result.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Ensure a subdirectory exists under the inputs directory.
   */
  private ensureInputsDir(subdir: string): string {
    const dir = path.join(getProjectDir(), this.config.inputsDir, subdir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Get default extension for a media type.
   */
  private getExtensionForMediaType(mediaType: InputMediaType): string {
    switch (mediaType) {
      case 'text':
        return 'txt';
      case 'audio':
        return 'mp3';
      case 'image':
        return 'jpg';
      case 'video':
        return 'mp4';
      default:
        return 'bin';
    }
  }

  /**
   * Check if a command is available.
   */
  private async checkCommand(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(command, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * Run a command and capture output.
   */
  private runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        reject(new Error(`Command failed: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command exited with code ${code}: ${stderr}`));
        }
      });
    });
  }
}

/**
 * Singleton instance for convenience.
 */
export const inputProcessor = new InputProcessor();
