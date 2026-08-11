# Example skills

Vera ships no enabled workflow skills by default. These examples are reference implementations users can copy and edit.

Install one for a project:

```sh
mkdir -p .vera/skills
cp -R examples/skills/consult .vera/skills/
```

Install one for the current user by copying it to `~/.vera/skills/` instead. Vera discovers the skill on the next turn and initially contributes only its name, description, and `SKILL.md` path. Ask naturally or name it explicitly as `$consult` or `$browser-research`.

- `consult` demonstrates parallel sibling-agent orchestration.
- `browser-research` demonstrates a workflow over the separately installed Vera Chrome extension. It adds no browser capability itself.
