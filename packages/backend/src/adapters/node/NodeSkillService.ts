import path from 'node:path'
import type { NodeSettingsService } from './NodeSettingsService'
import {
  FileSkillStore,
  type SkillInfo,
  type CreateOrRewriteSkillResult
} from '../../skills/FileSkillStore'

export type { SkillInfo, CreateOrRewriteSkillResult }

export class NodeSkillService {
  private readonly skillsDir: string
  private readonly core: FileSkillStore

  constructor(dataDir: string, private readonly settingsService?: NodeSettingsService) {
    this.skillsDir = path.join(dataDir, 'skills')
    this.core = new FileSkillStore({
      getScanRoots: () => [this.skillsDir],
      getPrimaryRoot: () => this.skillsDir,
      getSkillEnabledMap: () => this.settingsService?.getSettings().tools?.skills ?? {},
      logger: {
        error: (message, error) => console.error(message, error)
      }
    })
  }

  getSkillsDir(): string {
    return this.skillsDir
  }

  async reload(): Promise<SkillInfo[]> {
    return this.core.reload()
  }

  async getAll(): Promise<SkillInfo[]> {
    return this.core.getAll()
  }

  async getEnabledSkills(): Promise<SkillInfo[]> {
    return this.core.getEnabledSkills()
  }

  async readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }> {
    return this.core.readSkillContentByName(name)
  }

  async createOrRewriteSkill(name: string, description: string, content: string): Promise<CreateOrRewriteSkillResult> {
    return this.core.createOrRewriteSkill(name, description, content)
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    return this.core.createSkillFromTemplate()
  }
}
