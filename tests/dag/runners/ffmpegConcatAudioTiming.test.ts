import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegConcatRunner } from '../../../src/dag/runners/ffmpegConcat.js';
import { ffmpegBin, ffprobeBin } from '../../../src/dag/runners/ffmpegBin.js';
import type { RunnerContext } from '../../../src/dag/schema.js';

it('keeps decoded AAC narration on the video timeline across three hard cuts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concat-audio-timing-'));
  vi.stubEnv('dhee_WATERMARK', 'off');
  try {
    const files = [997, 1231, 1493].map((frequency, i) => {
      const path = join(dir, `${i}.mp4`);
      execFileSync(ffmpegBin(), ['-v','error','-y','-f','lavfi','-i','color=size=64x64:rate=24:duration=1',
        '-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=44100:duration=1`,
        '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',path]);
      return path;
    });
    const ctx = { projectDir:dir, inputs:{}, log:()=>{}, node:{ id:'final_video', kind:'stage', inputs:[],
      outputs:{format:'video',pattern:'final.mp4'},runner:{tool:'ffmpeg.concat',config:{inputs:files,outputPath:'final.mp4'}}} } as RunnerContext;
    const result = await ffmpegConcatRunner.run(ctx);
    expect(result.ok).toBe(true);
    const decode = (path:string) => execFileSync(ffmpegBin(), ['-v','error','-i',path,'-map','0:a:0','-ar','44100','-ac','1','-f','f32le','pipe:1']);
    const final = decode(join(dir,'final.mp4'));
    for (let clip = 0; clip < 3; clip++) {
      const original = decode(files[clip]!); let dot=0, aa=0, bb=0;
      // Ignore encoder edges, but do NOT shift samples to make a bad timeline pass.
      for(let i=2205;i<41895;i++) {
        const a=original.readFloatLE(i*4), b=final.readFloatLE((clip*44100+i)*4);
        dot+=a*b;aa+=a*a;bb+=b*b;
      }
      expect(dot/Math.sqrt(aa*bb), `clip ${clip} at its exact scheduled position`).toBeGreaterThan(.99);
    }
    const duration=Number(execFileSync(ffprobeBin(),['-v','error','-show_entries','format=duration','-of','csv=p=0',join(dir,'final.mp4')],{encoding:'utf8'}));
    expect(duration).toBeCloseTo(3,2);
  } finally { vi.unstubAllEnvs(); rmSync(dir,{recursive:true,force:true}); }
}, 30000);

it.each([
  { fps: 30, audio: true, error: /normalize clip frame rates/ },
  { fps: 24, audio: false, error: /mixed audio\/silent clips/ },
])('refuses unsupported mixed input policy: $fps fps, audio=$audio', async ({fps,audio,error}) => {
  const dir=mkdtempSync(join(tmpdir(),'concat-policy-'));vi.stubEnv('dhee_WATERMARK','off');
  try {
    const files=[join(dir,'a.mp4'),join(dir,'b.mp4')];
    files.forEach((path,i)=>execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`color=size=64x64:rate=${i===0?24:fps}:duration=1`,
      ...(i===0||audio?['-f','lavfi','-i','sine=frequency=997:sample_rate=44100:duration=1','-c:a','aac']:[]),
      '-c:v','libx264','-pix_fmt','yuv420p',path]));
    const result=await ffmpegConcatRunner.run({projectDir:dir,inputs:{},log:()=>{},node:{id:'final_video',kind:'stage',inputs:[],outputs:{format:'video',pattern:'final.mp4'},runner:{tool:'ffmpeg.concat',config:{inputs:files,outputPath:'final.mp4'}}}} as RunnerContext);
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatch(error);
  }finally{vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
},30000);
