import path from 'node:path'
import { app, shell } from 'electron'
import { SettingsService } from './SettingsService'
import {
  FileSkillStore,
  type SkillInfo,
  type CreateOrRewriteSkillResult
} from '../skills/FileSkillStore'

export type { SkillInfo, CreateOrRewriteSkillResult }

export class SkillService {
  private settingsService?: SettingsService
  private readonly core: FileSkillStore

  constructor(settingsService?: SettingsService) {
    this.settingsService = settingsService
    this.core = new FileSkillStore({
      getScanRoots: () => this.getSkillsDirs(),
      getPrimaryRoot: () => this.getSkillsDirs()[0],
      getSkillEnabledMap: () => this.settingsService?.getSettings().tools?.skills ?? {},
      openPath: async (absolutePath: string) => {
        await shell.openPath(absolutePath)
      },
      logger: {
        error: (message, error) => console.error(message, error)
      }
    })
  }

  setSettingsService(settingsService: SettingsService): void {
    this.settingsService = settingsService
  }

  getSkillsDirs(): string[] {
    const dirs: string[] = []

    const baseDir = app.getPath('userData')
    dirs.push(path.join(baseDir, 'skills'))

    const homeDir = app.getPath('home')
    if (homeDir) {
      dirs.push(path.join(homeDir, '.claude', 'skills'))
      dirs.push(path.join(homeDir, '.agents', 'skills'))

      if (process.platform === 'win32') {
        const appData = process.env.APPDATA
        if (appData) {
          dirs.push(path.join(appData, 'agents', 'skills'))
        }
      } else {
        dirs.push(path.join(homeDir, '.config', 'agents', 'skills'))
      }
    }

    return [...new Set(dirs)]
  }

  async ensureSkillsDir(): Promise<void> {
    await this.core.ensureSkillsDir()
  }

  async openSkillsFolder(): Promise<void> {
    await this.core.openSkillsFolder()
  }

  async openSkillFile(fileName: string): Promise<void> {
    await this.core.openSkillFile(fileName)
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    await this.core.deleteSkillFile(fileName)
  }

  async createOrRewriteSkill(
    name: string,
    description: string,
    content: string
  ): Promise<CreateOrRewriteSkillResult> {
    return this.core.createOrRewriteSkill(name, description, content)
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    return this.core.createSkillFromTemplate()
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
}
