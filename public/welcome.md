# 👋 Bienvenido a Markdown Viewer

Esto es el **borrador**: lo que escribas aquí se guarda solo en tu navegador. Para trabajar con archivos reales, ábrelos desde la terminal y cualquier cambio en disco (vim, VS Code, un script…) aparecerá aquí al instante.

```sh
mdview notas.md      # abre un archivo (si no existe, se crea al guardar)
mdview ~/docs        # abre una carpeta y lista todos sus .md
```

## Encabezados
# H1
## H2
### H3
#### H4
##### H5
###### H6

---

## Estilos de texto
Texto normal, **negrita**, _itálica_, **_negrita itálica_**, ~~tachado~~, `código en línea` y <mark>resaltado</mark>.

> ### Citas
> Markdown es un lenguaje de marcado ligero.
>> Las citas anidadas también funcionan.

## Listas
- Viñeta
  - Viñeta anidada
- [x] Tarea completa
- [ ] Tarea pendiente (haz clic en la casilla de la vista previa)

1. Elemento ordenado
2. Otro elemento
   1. Subelemento

## Enlaces e imágenes
[Markdown Viewer](https://example.com) · [ir a Tablas](#tablas) · https://autolink.example.com

Las rutas relativas (`![](img/foto.png)`, `[otro](otro.md)`) se resuelven desde la carpeta del archivo abierto.

## Tablas
| Función          | Estado  | Notas                        |
|------------------|:-------:|------------------------------|
| Archivos locales | ✅      | `mdview archivo.md`          |
| Recarga en vivo  | ✅      | vía `fs.watch` + SSE         |
| Tema oscuro      | ✅      | botón arriba a la derecha    |

## Bloque de código
```js
function saludar(nombre) {
  return `Hola, ${nombre}!`;
}
```

```diff
- antes
+ después
```

## Notas al pie
Una frase con nota[^1].

[^1]: Y aquí está la nota.

## Atajos
| Tecla    | Acción                           |
|----------|----------------------------------|
| Ctrl+S   | Guardar en disco                 |
| Ctrl+P   | Buscar y abrir un archivo        |
| Enter    | Continúa listas automáticamente  |
