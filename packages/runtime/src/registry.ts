import type { SkillSpec } from "./skill.ts";

export class SkillRegistry {
  #skills = new Map<string, SkillSpec>();

  register(spec: SkillSpec): this {
    if (this.#skills.has(spec.name)) throw new Error(`skill already registered: ${spec.name}`);
    this.#skills.set(spec.name, spec);
    return this;
  }

  get(name: string): SkillSpec {
    const s = this.#skills.get(name);
    if (!s) throw new Error(`unknown skill "${name}". Registered: ${[...this.#skills.keys()].join(", ")}`);
    return s;
  }

  has(name: string): boolean { return this.#skills.has(name); }
  list(): SkillSpec[] { return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name)); }
}
