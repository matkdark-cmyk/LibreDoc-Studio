# LibreDoc Studio

Aplicación de escritorio nativa e instalable para **Windows (NSIS `.exe`)** orientada a analizar, desbloquear, aplicar OCR 100% offline, editar formularios con vista general de datos y exportar documentos PDF/DOCX/texto conservando el diseño visual original y la persistencia completa entre versiones.

---

## Arquitectura clave

- **Instalador nativo Windows (NSIS):** `LibreDoc-Studio-Setup-<versión>.exe` con selección de carpeta de instalación, acceso directo en Escritorio y Menú Inicio, sin borrar jamás los datos del usuario al actualizar (`deleteAppDataOnUninstall: false`).
- **Persistencia versionada entre versiones:** SQLite (`better-sqlite3`) guardado en `%APPDATA%\LibreDocStudio\data\libredoc.db` junto a `workspaces/` y `backups/`, con migraciones automáticas (`schema_migrations`) y restauración exacta de `session_state`.
- **Procesamiento 100% local:**
  - `qpdf` empaquetado en `resources/bin/win/qpdf/` para inspección y desbloqueo de PDF.
  - `tesseract.js` + modelos `spa.traineddata` y `eng.traineddata` empaquetados en `resources/tessdata/` para OCR offline.
- **Auto-actualización por GitHub Releases:** `electron-updater` consulta `latest.yml`, pregunta al usuario antes de descargar, guarda la sesión (`pending_restore = 1`), abre la ventana dedicada con progreso `0%–100%` + velocidad + MB, instala silenciosamente y reabre exactamente donde quedó el usuario.

---

## Desarrollo local en Windows

```bash
npm install
npm run rebuild:native
npm run setup:assets
npm run electron:dev
```

- `npm run setup:assets` descarga automáticamente `qpdf.exe` + DLLs en `resources/bin/win/qpdf/` y los modelos OCR `spa.traineddata` y `eng.traineddata` en `resources/tessdata/`.
- `npm run dist:win` compila un instalador NSIS local en `release/` sin publicar en GitHub.

---

## Guía paso a paso: Compilar en GitHub Actions y probar el ciclo completo `v1.0.0 → v1.0.1`

### Paso 1: Configurar tu repositorio en `electron-builder.yml`

Abre `electron-builder.yml` y reemplaza las dos líneas del bloque `publish`:

```yaml
publish:
  provider: github
  owner: TU_USUARIO_GITHUB      # <-- Tu usuario u organización de GitHub
  repo: TU_REPOSITORIO_GITHUB   # <-- Nombre exacto de tu repositorio
  releaseType: release
```

> Nota: El workflow `.github/workflows/release.yml` además inyecta automáticamente `github.repository_owner` y `github.event.repository.name` durante la compilación en GitHub Actions, y cuenta con `permissions: contents: write` para publicar la release sin pasos manuales.

### Paso 2: Subir el código a GitHub y activar la compilación automática del instalador `.exe`

El archivo `.github/workflows/release.yml` hace que **GitHub Actions detecte el proyecto automáticamente** en tres casos:
- **Al subir código a `main` o `master`:** GitHub inicia de inmediato la compilación del instalador nativo NSIS `.exe` (ya vinculado a tu repositorio mediante `app-update.yml` para futuras actualizaciones) y lo deja descargable en **Actions → Artifacts**.
- **Al subir un tag (`v1.0.0`, `v1.0.1`, etc.):** GitHub compila el instalador nativo `.exe` y publica automáticamente la **GitHub Release** oficial con `LibreDoc-Studio-Setup-<versión>.exe`, `.blockmap` y `latest.yml` (que leen las instalaciones existentes para auto-actualizarse).
- **Manual desde la web de GitHub:** en **Actions → Build and Release Windows Installer → Run workflow**, puedes elegir la versión y compilar/publicar con un clic.

Pasos exactos para tu primera versión instalable `v1.0.0`:

1. Crea un repositorio nuevo en GitHub (público para que `electron-updater` pueda descargar Releases sin token privado).
2. Cambia `"version"` en `package.json` a `"1.0.0"` (si subes el tag `v1.0.0`, el workflow también sincroniza la versión automáticamente).
3. Inicializa Git, sube el código a `main` y publica el tag `v1.0.0`:

```bash
git init
git add .
git commit -m "Release inicial LibreDoc Studio v1.0.0"
git branch -M main
git remote add origin https://github.com/TU_USUARIO_GITHUB/TU_REPOSITORIO_GITHUB.git
git push -u origin main

git tag v1.0.0
git push origin v1.0.0
```

4. Entra en la pestaña **Actions** de tu repositorio en GitHub: verás el workflow **Build and Release Windows Installer** ejecutándose en `windows-latest`.
5. Al terminar en verde, entra en **Releases** y confirma los tres archivos publicados:
   - `LibreDoc-Studio-Setup-1.0.0.exe` (instalador nativo NSIS que queda instalado en Windows con `app-update.yml` apuntando a tu repo)
   - `LibreDoc-Studio-Setup-1.0.0.exe.blockmap`
   - `latest.yml`

### Paso 3: Instalar `v1.0.0` en tu PC con Windows

1. Descarga `LibreDoc-Studio-Setup-1.0.0.exe` desde GitHub Releases y ejecútalo.
2. Verifica que el instalador NSIS te permite elegir la carpeta de destino y crea el acceso directo en el **Escritorio** y el **Menú Inicio**.
3. Abre **LibreDoc Studio** desde el acceso directo instalado.

### Paso 4: Cargar y rellenar parcialmente un documento en `v1.0.0`

1. En **Inicio / Documentos**, arrastra o carga un archivo (PDF bloqueado, PDF escaneado/foto o Word `.docx`) y procésalo (desbloqueo u OCR si corresponde).
2. Ábrelo en el **Editor**, rellena algunos campos en la **Vista General de Datos** (deja otros sin completar), ajusta el zoom (por ejemplo `125%`) o activa el modo oscuro.
3. Deja la aplicación abierta exactamente en ese documento (o ciérrala y vuelve a abrirla para confirmar que `v1.0.0` restaura la sesión).
4. Opcional: verifica en **Actualizaciones → Carpeta de datos** que existe `%APPDATA%\LibreDocStudio\data\libredoc.db`.

### Paso 5: Publicar una mejora visible como `v1.0.1`

1. Haz un pequeño cambio visible en la interfaz (por ejemplo, agrega un texto breve o mejora en `src/pages/WorkspacePage.tsx` o en las notas de la release) para distinguir claramente `v1.0.1`.
2. Actualiza `"version"` en `package.json` de `"1.0.0"` a `"1.0.1"`.
3. Sube el cambio y empuja el tag `v1.0.1`:

```bash
git add .
git commit -m "Mejora visible y prueba de auto-actualización v1.0.1"
git push origin main

git tag v1.0.1
git push origin v1.0.1
```

4. Espera a que GitHub Actions compile y publique la release `v1.0.1` (con `LibreDoc-Studio-Setup-1.0.1.exe`, `.blockmap` y `latest.yml`).

### Paso 6: Validar la auto-actualización en vivo en Windows

1. Abre tu **LibreDoc Studio v1.0.0** instalado en Windows (si ya estaba abierto en tu documento parcialmente rellenado, ve a **Actualizaciones → Buscar actualizaciones ahora**, o simplemente reabre la app para probar la búsqueda automática al inicio).
2. Comprueba la secuencia completa en tiempo real:
   - Aparece el diálogo **Nueva versión disponible (`v1.0.0 → v1.0.1`)** con las notas de cambios y los botones **Más tarde** / **Actualizar ahora**.
   - Al pulsar **Actualizar ahora**:
     1. La app guarda inmediatamente el estado exacto en SQLite (`session_state.pending_restore = 1`).
     2. Se oculta la ventana principal y se abre la **ventana dedicada de actualización** centrada en pantalla.
     3. Muestra en vivo la **barra de progreso**, el **porcentaje exacto (`0%` a `100%`)**, la **velocidad (`MB/s`)** y los **MB descargados / totales**.
     4. Al llegar a `100%`, ejecuta `quitAndInstall(true, true)`: instala silenciosamente `v1.0.1` sin borrar `%APPDATA%\LibreDocStudio` y relanza automáticamente la aplicación.
     5. Al abrir `v1.0.1`, restaura exactamente el documento abierto, la página, el zoom, el tema y todos los campos que habías rellenado en `v1.0.0`, mostrando el banner verde confirmando la actualización a `v1.0.1` y registrando ambas versiones en **Actualizaciones → Historial de versiones instaladas**.

---

## Lista rápida de solución de problemas en GitHub Actions

- **Error de versión vs tag:** asegúrate de que `"version"` en `package.json` (ej. `"1.0.1"`) coincida exactamente con el tag sin la `v` (`v1.0.1`).
- **Repositorio privado:** `electron-updater` necesita que el repositorio (o sus Releases) sea público, salvo que se configure un token de descarga privado.
- **Firma de código en Windows:** si aún no usas certificado Authenticode, Windows SmartScreen puede mostrar *"Windows protegió su PC"* la primera vez; selecciona **Más información → Ejecutar de todas formas**.
