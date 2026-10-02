# mdview

Visor/editor de Markdown en el navegador (estilo markdownonline.org) que trabaja
sobre **archivos locales** y aplica al instante los cambios hechos en disco por
cualquier otro programa (vim, VS Code, scripts…).

La misma página funciona de dos modos:

| | CLI local (`mdview`) | Web estática (`npm run build`) |
|---|---|---|
| Navegadores | todos, Firefox incluido | Chrome/Edge para archivos; el resto solo borrador |
| Acceso a archivos | servidor Node en `127.0.0.1` | File System Access API, sin servidor |
| Cambios en disco | `fs.watch` + SSE, al instante | sondeo de `lastModified` cada 0,5 s |
| Archivos nuevos en la carpeta | al instante | cada 4 s |

Al cargar, la página detecta el modo sola: si responde `api/info` está detrás
de `mdview`; si no, y el navegador tiene `showDirectoryPicker`, ofrece
«Abrir carpeta» / «Abrir archivo» (o arrastrar una carpeta a la página); si
tampoco, queda el borrador guardado en el navegador.

## Modo CLI

```sh
npm install
node bin/mdview.js notas.md      # abre un archivo (se crea al guardar si no existe)
node bin/mdview.js ~/docs        # abre una carpeta y lista todos sus .md
node bin/mdview.js --help
```

## Modo web

```sh
npm run build                    # genera dist/ (HTML + JS + CSS, sin backend)
python3 -m http.server -d dist   # o cualquier hosting estático con HTTPS
```

La API exige contexto seguro: HTTPS, o `http://localhost` / `127.0.0.1`.
Los archivos nunca salen de la máquina; el hosting solo entrega la página.
Las carpetas abiertas se recuerdan en IndexedDB: al volver, se reabren solas si
el navegador conservó el permiso, o con un clic si no. Para ver imágenes
relativas hay que abrir la carpeta (un archivo suelto no da acceso a su carpeta).
`dist/` no incluye `src/server.js`: no expone ningún sistema de archivos.

### Despliegue (Cloud Run)

El `Dockerfile` arma `dist/` con Node y lo sirve con
[static-web-server](https://static-web-server.net/) sobre `scratch`
(imagen final de ~9 MB, sin Node). Headers y CSP en `deploy/sws.toml`.

```sh
gcloud run deploy markdown-viewer --source . \
  --account=promolic1@gmail.com --project=angel-gce --region=us-central1 \
  --allow-unauthenticated --max-instances=1 --min-instances=0 \
  --execution-environment=gen1 --memory=128Mi --cpu=1 --port=8080
```

Publicado en https://markdown-viewer-536609787755.us-central1.run.app

## Cómo funciona

- `public/sources.js` define las «fuentes» de archivos (`ServerSource`,
  `FsSource`, `NullSource`) con una interfaz común; `public/app.js` no sabe
  cuál está usando.
- `bin/mdview.js` levanta un servidor HTTP en `127.0.0.1` (puerto 4747 o el
  siguiente libre) y abre el navegador.
- `src/server.js` vigila con `fs.watch` los **directorios** (no los archivos, para
  sobrevivir a los guardados por renombrado de vim y compañía) y avisa al
  navegador por Server-Sent Events con el contenido nuevo y su hash.
- `public/app.js` renderiza con markdown-it + DOMPurify + highlight.js y solo
  reemplaza en la vista previa los bloques que cambiaron: las imágenes no
  parpadean y el bloque modificado se resalta (y, con «Seguir cambios», se
  desplaza hasta él).

## Guardado y conflictos

- `Ctrl+S` guarda; «Autoguardar» guarda mientras escribes.
- Cada guardado lleva el hash de la versión en la que se basa; si el archivo
  cambió en disco entretanto, el servidor responde 409 y la página ofrece
  «Cargar la del disco» o «Conservar la mía».
- Sin cambios locales pendientes, los cambios en disco se aplican solos,
  conservando cursor, scroll e historial de deshacer.

## Seguridad

Solo escucha en loopback, rechaza cabeceras `Host` ajenas (DNS rebinding),
no permite rutas fuera de la carpeta raíz y solo escribe archivos Markdown.
