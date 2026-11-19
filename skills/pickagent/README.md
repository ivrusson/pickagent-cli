# Skill pickagent (PA-033)

Skill de agente para comparar planes de IA a partir del uso local medido por el escáner de [pickagent](https://pickagent.dev).

## Qué hace

Cuando preguntas cosas como «¿qué plan de IA me conviene?», «¿me compensa Max?» o «which AI plan should I pay for», el agente:

1. Te explica qué lee el escáner (solo agregados, nunca conversaciones).
2. Tras tu confirmación, ejecuta `npx @pickagent/cli scan` con los flags que toquen.
3. Te resume el perfil y abre el veredicto en el navegador, o usa el MCP público si prefieres no abrirlo.

## Paquete npm

El comando es `npx @pickagent/cli scan`. No hace falta clonar nada para ejecutarlo. Desde un clon de este repositorio, `npm ci && npm run build` y `node dist/cli.js scan`.

## Instalación — Claude Code

Copia o enlaza esta carpeta en tu skills de usuario:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/pickagent" ~/.claude/skills/pickagent
```

O clónala desde GitHub:

```bash
git clone https://github.com/ivrusson/pickagent-cli.git /tmp/pickagent-cli
ln -s /tmp/pickagent-cli/skills/pickagent ~/.claude/skills/pickagent
```

También puedes empaquetarla como plugin de Claude Code apuntando a `skills/pickagent/`.

## Instalación — Codex

```bash
mkdir -p ~/.codex/skills/pickagent
cp -R skills/pickagent/* ~/.codex/skills/pickagent/
```

Codex carga `~/.codex/skills/<name>/SKILL.md`.

## MCP opcional

Para simular sin navegador o explorar planes después del escaneo:

- Claude Code: `claude mcp add --transport http pickagent https://pickagent.dev/api/mcp`
- Codex: `codex mcp add pickagent --url https://pickagent.dev/api/mcp`

Detalle en [references/mcp.md](references/mcp.md).

## Contenido

| Archivo                           | Uso                                          |
| --------------------------------- | -------------------------------------------- |
| `SKILL.md`                        | Instrucciones del agente (cuerpo en inglés). |
| `references/mcp.md`               | Conexión MCP y herramientas públicas.        |
| `references/privacy-and-flags.md` | Contrato de privacidad y flags del CLI.      |

No hay scripts ni binarios en esta skill; solo documentación.
