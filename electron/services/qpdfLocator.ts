import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { QpdfStatus } from '../../shared/types';

export interface QpdfExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function getExpectedWinQpdfPath(): string {
  const resourcesRoot =
    typeof process.resourcesPath === 'string' &&
    fs.existsSync(path.join(process.resourcesPath, 'bin', 'win', 'qpdf'))
      ? path.join(process.resourcesPath, 'bin', 'win', 'qpdf', 'qpdf.exe')
      : path.join(process.cwd(), 'resources', 'bin', 'win', 'qpdf', 'qpdf.exe');
  return resourcesRoot;
}

export function runQpdfCommand(
  executablePath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<QpdfExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        cwd: fs.existsSync(executablePath) ? path.dirname(executablePath) : undefined,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        const errWithCode = error as NodeJS.ErrnoException & { code?: number | string };
        if (errWithCode.code === 'ENOENT') {
          reject(error);
          return;
        }
        const numericCode = typeof errWithCode.code === 'number' ? errWithCode.code : 2;
        resolve({
          exitCode: numericCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

async function probeExecutable(candidate: string): Promise<string | null> {
  try {
    const result = await runQpdfCommand(candidate, ['--version'], 5_000);
    if (result.exitCode === 0) {
      const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() ?? '';
      return firstLine || 'qpdf';
    }
    return null;
  } catch {
    return null;
  }
}

export async function locateQpdf(): Promise<QpdfStatus> {
  const expectedPath = getExpectedWinQpdfPath();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    if (typeof process.resourcesPath === 'string') {
      candidates.push(path.join(process.resourcesPath, 'bin', 'win', 'qpdf', 'qpdf.exe'));
    }
    candidates.push(path.join(process.cwd(), 'resources', 'bin', 'win', 'qpdf', 'qpdf.exe'));
    candidates.push('qpdf.exe');
    candidates.push('qpdf');
  } else {
    candidates.push('qpdf');
  }

  for (const candidate of candidates) {
    // Skip explicit file paths that do not exist
    if ((candidate.includes(path.sep) || candidate.includes('/')) && !fs.existsSync(candidate)) {
      continue;
    }
    const version = await probeExecutable(candidate);
    if (version) {
      return {
        available: true,
        executablePath: candidate,
        version,
        expectedPath,
      };
    }
  }

  return {
    available: false,
    executablePath: null,
    version: null,
    expectedPath,
  };
}
