# mdview

Visor/editor de Markdown en el navegador (estilo markdownonline.org) que trabaja
sobre **archivos locales** y aplica al instante los cambios hechos en disco por
cualquier otro programa (vim, VS Code, scripts…). Funciona en cualquier
navegador, Firefox incluido.

```sh
npm install
node bin/mdview.js notas.md      # abre un archivo (se crea al guardar si no existe)
node bin/mdview.js ~/docs        # abre una carpeta y lista todos sus .md
node bin/mdview.js --help
```

## Cómo funciona

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
