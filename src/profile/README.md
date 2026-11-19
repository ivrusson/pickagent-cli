# Contrato de perfil

Copia mínima del esquema `pickagent.profile/v1` (parse, encode, hash y armado
del perfil a partir de informes de uso).

Origen: repositorio privado `pickagent`, commit
[`ce76224d0864316df4f83bb302426b4e0035083e`](https://github.com/ivrusson/pickagent/commit/ce76224d0864316df4f83bb302426b4e0035083e).

| Aquí | Allí |
| --- | --- |
| `src/profile/ids.ts` | `src/lib/engine/ids.ts` |
| `src/profile/profile.ts` | `src/lib/engine/profile.ts` |
| `src/profile/ccusage.ts` | `src/lib/engine/ccusage.ts` |
| `src/profile/fragment.ts` | `src/lib/engine/fragment.ts` |
| `src/profile/merge-sources.ts` | `src/lib/engine/merge-sources.ts` |
| `src/profile/fixtures/orchestrator.ts` | la fixture `orchestrator` de `src/lib/engine/fixtures/profiles.ts` |

`index.ts` solo reexporta esos módulos para el CLI.

Recortes respecto al original: comentarios que apuntaban a otras partes del
producto. El esquema, `parseProfile`, `encodeProfile`, `profileToHash` y el
paso de informes de uso a perfil no se han cambiado. La fixture de tests es
solo `orchestrator` (y `hoursOf`, que esa fixture necesita). El resto de
personas de `fixtures/profiles.ts` no está aquí.

## Cómo resincronizar

1. Elige el commit de pickagent que quieres seguir.
2. Copia los cinco archivos de la tabla encima de `src/profile/`.
3. Sustituye `fixtures/orchestrator.ts` por esa fixture y el helper de horas
   que usa. No copies las otras personas de prueba.
4. No copies ningún otro archivo del directorio de origen. Si uno de los
   cinco pasa a importar un módulo que no está en esta tabla, borra ese
   import y el código que solo exista para atenderlo.
5. Vuelve a quitar comentarios que nombren piezas que no viven en este
   repositorio.
6. Escribe el nuevo commit de origen en este archivo.
7. `npm test` y `npm run build`. Revisa `dist/cli.js`: tiene que seguir siendo
   el escáner y este contrato, nada más.
