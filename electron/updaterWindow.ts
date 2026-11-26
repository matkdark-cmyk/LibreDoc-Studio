import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ThemeMode, UpdaterProgressPayload } from '../shared/types';

function resolveUpdaterIconPath(): string | undefined {
  const candidates = [
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'icons', 'icon.ico')
      : '',
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'icons', 'icon.png')
      : '',
    path.join(process.cwd(), 'resources', 'icons', 'icon.ico'),
    path.join(process.cwd(), 'resources', 'icons', 'icon.png'),
  ].filter(Boolean);

  return candidates.find((p) => fs.existsSync(p));
}

export class UpdaterWindowController {
  private win: BrowserWindow | null = null;
  private latestPayload: UpdaterProgressPayload | null = null;

  public open(initialPayload: UpdaterProgressPayload): BrowserWindow {
    this.latestPayload = initialPayload;

    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      this.sendProgress(initialPayload);
      return this.win;
    }

    const bgColor = initialPayload.theme === 'dark' ? '#0f172a' : '#ffffff';

    const updaterWin = new BrowserWindow({
      width: 480,
      height: 312,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      title: 'Actualizando LibreDoc Studio',
      icon: resolveUpdaterIconPath(),
      backgroundColor: bgColor,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win = updaterWin;

    updaterWin.once('ready-to-show', () => {
      updaterWin.show();
      if (this.latestPayload) {
        this.sendProgress(this.latestPayload);
      }
    });

    updaterWin.webContents.on('did-finish-load', () => {
      if (this.latestPayload) {
        this.sendProgress(this.latestPayload);
      }
    });

    updaterWin.on('closed', () => {
      this.win = null;
    });

    const devUrl = process.env.ELECTRON_DEV_URL;
    if (devUrl) {
      void updaterWin.loadURL(`${devUrl.replace(/\/+$/, '')}/#/updater-splash`);
    } else {
      void updaterWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
        hash: '/updater-splash',
      });
    }

    return updaterWin;
  }

  public sendProgress(payload: UpdaterProgressPayload): void {
    this.latestPayload = payload;
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
      this.win.webContents.send('updater:progress', payload);
    }
  }

  public getLatestPayload(): UpdaterProgressPayload | null {
    return this.latestPayload;
  }

  public isOpen(): boolean {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  public close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }

  public getTheme(): ThemeMode {
    return this.latestPayload?.theme ?? 'light';
  }
}
