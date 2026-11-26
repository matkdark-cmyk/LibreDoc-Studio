# Binario qpdf para Windows (x64)

Coloca aquí los archivos de la carpeta `bin/` del paquete oficial `qpdf-*-msvc64.zip` (o `qpdf-*-mingw64.zip`) descargado desde:
https://github.com/qpdf/qpdf/releases

O ejecuta automáticamente desde la raíz del proyecto:

```bash
npm run setup:qpdf
```

Archivos esperados en esta carpeta:
- `qpdf.exe`
- Todas las librerías `.dll` que acompañan a `qpdf.exe` dentro de `bin/` (ej. `qpdf*.dll`, `zlib1.dll`, `libjpeg*.dll`, o las DLL de MinGW/MSVC según la compilación).
