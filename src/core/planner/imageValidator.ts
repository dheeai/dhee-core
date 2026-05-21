/**
 * Image quality gate — validates generated images before proceeding to video.
 *
 * Two levels:
 * 1. Basic validation (always on): file exists, valid format, correct dimensions
 * 2. Vision model review (configurable): LLM reviews image against prompt
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

interface ExpectedDimensions {
  width: number;
  height: number;
}

/**
 * Validate a generated image meets basic quality requirements.
 *
 * Checks:
 * - File exists on disk
 * - File is a valid image (PNG/JPEG header check)
 * - Dimensions match expected (if sharp/image-size available)
 */
export async function validateGeneratedImage(
  imagePath: string,
  _prompt: string,
  expectedDimensions?: ExpectedDimensions,
): Promise<ImageValidationResult> {
  // Check file exists
  if (!existsSync(imagePath)) {
    return { valid: false, error: `Image file not found: ${imagePath}` };
  }

  // Read file header to validate format
  try {
    const buffer = await readFile(imagePath);

    if (buffer.length < 8) {
      return { valid: false, error: 'Image file is too small to be valid' };
    }

    // Check PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;

    // Check JPEG magic bytes: FF D8 FF
    const isJpeg =
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    if (!isPng && !isJpeg) {
      return { valid: false, error: 'Image file is not a valid PNG or JPEG' };
    }

    // Dimension check for PNG (width/height in IHDR chunk at bytes 16-23)
    if (isPng && expectedDimensions) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);

      if (
        width !== expectedDimensions.width ||
        height !== expectedDimensions.height
      ) {
        return {
          valid: false,
          error: `Dimension mismatch: got ${width}x${height}, expected ${expectedDimensions.width}x${expectedDimensions.height}`,
        };
      }
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Failed to read image file: ${(err as Error).message}`,
    };
  }
}

