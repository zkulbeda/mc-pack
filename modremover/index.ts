import { readFile, readdir, access, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import toml from 'toml';
import prompts from 'prompts';
import { execSync } from 'child_process';
import cliProgress from 'cli-progress';
import { rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ModrinthVersion {
  id: string;
  project_id: string;
  dependencies: {
    version_id: string | null;
    project_id: string | null;
    file_name: string | null;
    dependency_type: string;
  }[];
}

interface ModrinthProject {
  id: string;
  title: string;
  slug: string;
}

interface PackwizMod {
  name: string;
  file: string;
  projectId: string;
  fileName: string;
}

interface DependencyInfo {
  projectId: string;
  dependencyType: string;
}

interface EnrichedDependency extends DependencyInfo {
  projectName: string;
}

class PackwizDependencyAnalyzer {
  private modrinthApiBase = 'https://api.modrinth.com/v2';
  private excludedMods = new Set(['P7dR8mSH', 'mOgUt4GM']);
  private versionCache = new Map<string, ModrinthVersion[]>();
  private projectCache = new Map<string, ModrinthProject>();
  private progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  private cacheDir: string;
  private cacheMaxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  async run() {
    try {
      console.log('🔍 Finding project root...');
      const projectRoot = await this.findProjectRoot();
      
      // Initialize cache directory
      this.cacheDir = join(projectRoot, '.packwiz-cache');
      try {
        await mkdir(this.cacheDir, { recursive: true });
      } catch (error) {
        console.warn('⚠️ Could not create cache directory:', error instanceof Error ? error.message : error);
      }
      
      console.log('📦 Loading mods from pack...');
      const allMods = await this.getAllMods(projectRoot);
      
      const targetModId = await this.promptForModId();
      const targetMod = allMods.find(m => m.projectId === targetModId);
      
      if (!targetMod) {
        console.error(`❌ Mod with ID "${targetModId}" not found.`);
        process.exit(1);
      }
      
      console.log(`\n🔍 Found mod: ${targetMod.name}`);
      
      // Pre-fetch all mod versions with progress indicator
      console.log('📡 Fetching mod versions from Modrinth...');
      await this.preFetchAllModVersions(allMods);
      
      // Check if the target mod is a dependency of any other mods
      console.log('🔎 Checking if this mod is used by others...');
      const dependingMods = await this.checkIfModIsDependency(targetMod, allMods);
      
      if (dependingMods.length > 0) {
        console.log('\n⚠️  WARNING: This mod is required by other mods!');
        console.log('   The following mods depend on it:');
        dependingMods.forEach(mod => console.log(`   • ${mod.name}`));
        console.log('\n   Removing it may break these mods.');
        
        const response = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: 'Do you still want to proceed with removal?',
          initial: false
        });
        
        if (!response.confirm) {
          console.log('Removal cancelled.');
          return;
        }
      }
      
      console.log('📡 Analyzing target mod versions...');
      const targetVersions = this.versionCache.get(targetMod.projectId) || [];
      
      // Extract dependencies from all versions
      const dependencies = this.extractDependenciesFromVersions(targetVersions);
      
      if (dependencies.length === 0) {
        console.log('📦 No dependencies found.');
        await this.promptForRemoval([targetMod], [], projectRoot);
        return;
      }
      
      // Fetch project details for dependencies to get their names
      console.log('📋 Fetching dependency project details...');
      const dependenciesWithNames = await this.enrichDependenciesWithNames(dependencies);
      
      console.log('🔎 Analyzing dependency usage...');
      const dependencyUsage = await this.analyzeDependencies(dependenciesWithNames, allMods, targetMod);
      
      const { removableDeps, conflictingMods } = this.formatCompactResults(dependencyUsage, allMods);
      
      await this.promptForRemoval([targetMod, ...removableDeps], conflictingMods, projectRoot);
      
    } catch (error) {
      console.error('💥 Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  private async preFetchAllModVersions(allMods: PackwizMod[]) {
    this.progressBar.start(allMods.length, 0);
    
    for (let i = 0; i < allMods.length; i++) {
      const mod = allMods[i];
      try {
        if (!this.versionCache.has(mod.projectId)) {
          const versions = await this.fetchModVersionsWithCache(mod.projectId);
          this.versionCache.set(mod.projectId, versions);
        }
      } catch (error) {
        console.warn(`\n⚠️ Failed to fetch versions for ${mod.name}:`, error instanceof Error ? error.message : error);
      }
      this.progressBar.update(i + 1);
    }
    
    this.progressBar.stop();
  }

  private async fetchModVersionsWithCache(projectId: string): Promise<ModrinthVersion[]> {
    const cacheFile = join(this.cacheDir, `versions-${projectId}.json`);
    
    try {
      // Try to read from cache
      const cachedData = await readFile(cacheFile, 'utf-8');
      const cache = JSON.parse(cachedData);
      
      // Check if cache is still valid
      if (Date.now() - cache.timestamp < this.cacheMaxAge) {
        return cache.data;
      }
    } catch (error) {
      // Cache doesn't exist or is invalid, continue to fetch from API
    }
    
    // Fetch from API
    const versions = await this.fetchWithRetry(projectId);
    
    // Save to cache
    try {
      const cacheData = {
        timestamp: Date.now(),
        data: versions
      };
      await writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      console.warn(`⚠️ Could not write cache for ${projectId}:`, error instanceof Error ? error.message : error);
    }
    
    return versions;
  }

  private async fetchWithRetry(projectId: string, retries = 3): Promise<ModrinthVersion[]> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(`${this.modrinthApiBase}/project/${projectId}/version`, {
          headers: {
            'User-Agent': 'Packwiz-Dependency-Analyzer/1.0.0'
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json() as ModrinthVersion[];
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error('Failed to fetch after retries');
  }

  private async checkIfModIsDependency(targetMod: PackwizMod, allMods: PackwizMod[]): Promise<PackwizMod[]> {
    const dependingMods: PackwizMod[] = [];
    
    this.progressBar.start(allMods.length - 1, 0);
    let processed = 0;
    
    for (const mod of allMods) {
      if (mod.projectId === targetMod.projectId) continue;
      
      try {
        const modVersions = this.versionCache.get(mod.projectId) || [];
        const modDependencies = this.extractDependenciesFromVersions(modVersions);
        const dependsOnTarget = modDependencies.some(d => d.projectId === targetMod.projectId);
        
        if (dependsOnTarget) {
          dependingMods.push(mod);
        }
      } catch (error) {
        console.warn(`\n⚠️ Failed to check dependencies for ${mod.name}:`, error instanceof Error ? error.message : error);
      }
      
      processed++;
      this.progressBar.update(processed);
    }
    
    this.progressBar.stop();
    return dependingMods;
  }

  private async findProjectRoot(): Promise<string> {
    let currentDir = process.cwd();
    const maxDepth = 10;
    
    for (let depth = 0; depth < maxDepth; depth++) {
      try {
        await access(join(currentDir, 'pack.toml'));
        return currentDir;
      } catch (error) {
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
    }
    
    throw new Error('pack.toml not found. Run from packwiz project root.');
  }

  private async promptForModId(): Promise<string> {
    const response = await prompts({
      type: 'text',
      name: 'modId',
      message: 'Enter Modrinth project ID or slug:',
      validate: value => value.trim() === '' ? 'Please enter a mod ID or slug' : true
    });
    
    return response.modId.trim();
  }

  private async getAllMods(projectRoot: string): Promise<PackwizMod[]> {
    const modsDir = join(projectRoot, 'mods');
    try {
      const files = await readdir(modsDir);
      const modFiles = files.filter(f => f.endsWith('.toml'));
      
      const mods: PackwizMod[] = [];
      
      for (const file of modFiles) {
        try {
          const content = await readFile(join(modsDir, file), 'utf-8');
          const data = toml.parse(content);
          
          let projectId: string | undefined;
          
          if (data.update?.modrinth?.['mod-id']) {
            projectId = data.update.modrinth['mod-id'];
          } else if (data.update?.modrinth?.['project-id']) {
            projectId = data.update.modrinth['project-id'];
          }
          
          if (projectId) {
            mods.push({
              name: data.name || file.replace('.pw.toml', ''),
              file: join(modsDir, file),
              projectId,
              fileName: file
            });
          }
        } catch (error) {
          console.warn(`⚠️ Error parsing ${file}:`, error instanceof Error ? error.message : error);
        }
      }
      
      return mods;
    } catch (error) {
      throw new Error(`Could not read mods directory: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async getModVersions(projectId: string): Promise<ModrinthVersion[]> {
    return this.versionCache.get(projectId) || [];
  }

  private async getProjectDetails(projectId: string): Promise<ModrinthProject> {
    if (this.projectCache.has(projectId)) {
      return this.projectCache.get(projectId)!;
    }
    
    const cacheFile = join(this.cacheDir, `project-${projectId}.json`);
    
    try {
      // Try to read from cache
      const cachedData = await readFile(cacheFile, 'utf-8');
      const cache = JSON.parse(cachedData);
      
      // Check if cache is still valid
      if (Date.now() - cache.timestamp < this.cacheMaxAge) {
        this.projectCache.set(projectId, cache.data);
        return cache.data;
      }
    } catch (error) {
      // Cache doesn't exist or is invalid, continue to fetch from API
    }
    
    // Fetch from API
    const response = await fetch(`${this.modrinthApiBase}/project/${projectId}`, {
      headers: {
        'User-Agent': 'Packwiz-Dependency-Analyzer/1.0.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch project details: ${response.status} ${response.statusText}`);
    }
    
    const project: ModrinthProject = await response.json() as ModrinthProject;
    
    // Save to cache
    try {
      const cacheData = {
        timestamp: Date.now(),
        data: project
      };
      await writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      console.warn(`⚠️ Could not write cache for project ${projectId}:`, error instanceof Error ? error.message : error);
    }
    
    this.projectCache.set(projectId, project);
    
    return project;
  }

  private extractDependenciesFromVersions(versions: ModrinthVersion[]): DependencyInfo[] {
    const dependencies: DependencyInfo[] = [];
    const seen = new Set<string>();
    
    for (const version of versions) {
      for (const dep of version.dependencies || []) {
        if (dep.project_id && dep.dependency_type === 'required' && !seen.has(dep.project_id)) {
          seen.add(dep.project_id);
          dependencies.push({
            projectId: dep.project_id,
            dependencyType: dep.dependency_type
          });
        }
      }
    }
    
    return dependencies;
  }

  private async enrichDependenciesWithNames(dependencies: DependencyInfo[]): Promise<EnrichedDependency[]> {
    const result: EnrichedDependency[] = [];
    
    this.progressBar.start(dependencies.length, 0);
    
    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      
      if (this.excludedMods.has(dep.projectId)) {
        continue;
      }
      
      try {
        const projectDetails = await this.getProjectDetails(dep.projectId);
        result.push({
          ...dep,
          projectName: projectDetails.title
        });
      } catch (error) {
        console.warn(`\n⚠️ Failed to fetch details for project ${dep.projectId}:`, error instanceof Error ? error.message : error);
        result.push({
          ...dep,
          projectName: dep.projectId
        });
      }
      
      this.progressBar.update(i + 1);
    }
    
    this.progressBar.stop();
    return result;
  }

  private async analyzeDependencies(
    dependencies: EnrichedDependency[],
    allMods: PackwizMod[],
    targetMod: PackwizMod
  ): Promise<{dependency: EnrichedDependency, usedBy: PackwizMod[]}[]> {
    const results: {dependency: EnrichedDependency, usedBy: PackwizMod[]}[] = [];
    
    this.progressBar.start(dependencies.length, 0);
    
    for (let i = 0; i < dependencies.length; i++) {
      const dependency = dependencies[i];
      const usedBy: PackwizMod[] = [];
      
      for (const mod of allMods) {
        if (mod.projectId === targetMod.projectId) continue;
        
        try {
          const modVersions = this.versionCache.get(mod.projectId) || [];
          const modDependencies = this.extractDependenciesFromVersions(modVersions);
          const dependsOnThis = modDependencies.some(d => d.projectId === dependency.projectId);
          
          if (dependsOnThis) {
            usedBy.push(mod);
          }
        } catch (error) {
          console.warn(`\n⚠️ Failed to check ${mod.name}:`, error instanceof Error ? error.message : error);
        }
      }
      
      results.push({
        dependency,
        usedBy
      });
      
      this.progressBar.update(i + 1);
    }
    
    this.progressBar.stop();
    return results;
  }

  private formatCompactResults(analysis: {dependency: EnrichedDependency, usedBy: PackwizMod[]}[], allMods: PackwizMod[]): { removableDeps: PackwizMod[], conflictingMods: PackwizMod[] } {
    const removableDeps: PackwizMod[] = [];
    const conflictingMods: PackwizMod[] = [];
    
    console.log('\n📊 Compact Dependency Report');
    console.log('============================');
    
    const unusedDeps = analysis.filter(item => item.usedBy.length === 0);
    const usedDeps = analysis.filter(item => item.usedBy.length > 0);
    
    if (unusedDeps.length > 0) {
      console.log('\n✅ Unused Dependencies (safe to remove):');
      for (const item of unusedDeps) {
        const modData = allMods.find(m => m.projectId === item.dependency.projectId)
        if (!modData) continue;
        console.log(`   • ${item.dependency.projectName}`);
        removableDeps.push(modData);
      }
    }
    
    if (usedDeps.length > 0) {
      console.log('\n⚠️  Used Dependencies (required by other mods):');
      for (const item of usedDeps) {
        const usedByNames = item.usedBy.map(m => m.name).join(', ');
        console.log(`   • ${item.dependency.projectName} - used by: ${usedByNames}`);
        for (const mod of item.usedBy) {
          if (!conflictingMods.some(m => m.projectId === mod.projectId)) {
            conflictingMods.push(mod);
          }
        }
      }
    }
    
    if (unusedDeps.length === 0 && usedDeps.length === 0) {
      console.log('No dependencies to analyze.');
    }
    
    return { removableDeps, conflictingMods };
  }

  private async promptForRemoval(modsToRemove: PackwizMod[], conflictingMods: PackwizMod[], projectRoot: string) {
    if (modsToRemove.length === 0) {
      console.log('\n📝 No mods to remove.');
      return;
    }
    
    if (conflictingMods.length > 0) {
      console.log('\n⚠️  Note: Some dependencies are used by other mods and won\'t be removed.');
    }
    
    console.log('\n🗑️  Mods to remove:');
    for (const mod of modsToRemove) {
      console.log(`   • ${mod.name}`);
    }
    
    const response = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Run packwiz remove for these mods?',
      initial: true
    });
    
    if (response.confirm) {
      for (const mod of modsToRemove) {
        try {
          console.log(`Removing ${mod.name}...`);
          rmSync(mod.file);
          
        } catch (error) {
          console.error(`Failed to remove ${mod.name}:`, error instanceof Error ? error.message : error);
        }
      }
      execSync(`${join(projectRoot, "packwiz.exe")} refresh`, { 
            stdio: 'inherit',
            cwd: projectRoot
          });
      console.log('✅ Removal completed!');
    } else {
      console.log('Removal cancelled.');
    }
  }
}

// Run the application
const analyzer = new PackwizDependencyAnalyzer();
analyzer.run().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});