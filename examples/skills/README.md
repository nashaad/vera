# Example skills

Vera ships one skill, `vera-help`, which reads the product guide and does nothing else. It ships no workflow skills. These examples are reference implementations users can copy and edit.

Install one for a project:

```sh
mkdir -p .vera/skills
cp -R examples/skills/consult .vera/skills/
```

Install one for the current user by copying it to `~/.vera/skills/` instead. Vera discovers the skill on the next turn and initially contributes only its name, description, and `SKILL.md` path. Ask naturally or name it explicitly, as in `$consult`.

- `consult` demonstrates parallel sibling-agent orchestration.
