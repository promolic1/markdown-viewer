# mdview

Visor/editor de Markdown en el navegador (estilo markdownonline.org) que trabaja
sobre **archivos locales** y aplica al instante los cambios hechos en disco por
cualquier otro programa (vim, VS Code, scripts…).

La misma página funciona de tres maneras:

| | `mdview` (página local) | Web + `mdview --web` | Web sola (Chrome/Edge) |
|---|---|---|---|
| Navegadores | todos | todos | Chromium; el resto solo borrador |
| Acceso a archivos | servidor Node en `127.0.0.1` | la página publicada habla con ese mismo servidor (CORS + token) | File System Access API |
| Cambios en disco | `fs.watch` + SSE, al instante | igual | sondeo cada 0,5 s |
| Instalar algo | sí | sí | no |

Al cargar, la página detecta qué hay (por capacidades, no por navegador):
1. ¿la sirve `mdview`? (`api/info` en el mismo origen)
2. ¿hay un `mdview` local emparejado que responde?
3. ¿existe `showDirectoryPicker`? → «Abrir carpeta» / «Abrir archivo»
4. si nada de lo anterior, el borrador guardado en el navegador.

## Modo CLI

```sh
npm install
node bin/mdview.js notas.md      # abre un archivo (se crea al guardar si no existe)
node bin/mdview.js ~/docs        # abre una carpeta y lista todos sus .md
node bin/mdview.js --help
```

## Web + `mdview` local (cualquier navegador)

```sh
mdview --web notas.md     # abre la versión publicada, conectada a este mdview
```

Un mismo proceso sirve la página local y atiende a la publicada; no hay un
segundo servidor. `--web` abre la web con `#agent=…&token=…`: lo que va tras
el `#` no sale del navegador, así que Cloud Run no ve ni el token ni los
nombres de archivo. La página guarda el emparejamiento y la próxima vez
encuentra sola a `mdview` mientras esté corriendo (con o sin `--web`); si no
responde, la barra lateral lo dice y ofrece «Reintentar».

Seguridad del servidor:
- el token es persistente, se guarda en `~/.config/mdview/token` (`%APPDATA%`
  en Windows, `~/Library/Application Support` en macOS) con permisos 600;
- solo los orígenes de la versión publicada (más `--allow-origin`) reciben
  CORS, y siempre con el token;
- cualquier petición de otro sitio, incluidas las de `<img>` que no mandan
  `Origin`, se detecta con `Sec-Fetch-Site` y exige el token;
- la página solo acepta emparejarse con direcciones de loopback.

## Web sola (Chrome/Edge)

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
