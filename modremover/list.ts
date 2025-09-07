import { readFile, readdir, access, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import toml from 'toml';
import { writeFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackwizMod {
  name: string;
  projectId: string;
  fileName: string;
}

interface ModrinthProject {
  id: string;
  title: string;
  slug: string;
  categories: string[];
  client_side: 'required' | 'optional' | 'unsupported';
  server_side: 'required' | 'optional' | 'unsupported';
}

interface EnrichedMod extends PackwizMod {
  title: string;
  slug: string;
  categories: string[];
  isDependency: boolean;
  dependents: string[];
  client_side: 'required' | 'optional' | 'unsupported';
  server_side: 'required' | 'optional' | 'unsupported';
}

class ModListGenerator {
  private modrinthApiBase = 'https://api.modrinth.com/v2';
  private cacheDir: string;
  private cacheMaxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  private projectCache = new Map<string, ModrinthProject>();
  private versionCache = new Map<string, any[]>();

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
      
      console.log('📋 Fetching mod details from Modrinth...');
      const enrichedMods = await this.enrichModsWithDetails(allMods);
      
      console.log('🔍 Analyzing dependencies...');
      const modsWithDependencyInfo = await this.analyzeDependencies(enrichedMods);
      
      console.log('📝 Generating mod list...');
      await this.generateModListMarkdown(modsWithDependencyInfo, projectRoot);
      
      console.log('✅ Mod list generated successfully!');
      
    } catch (error) {
      console.error('💥 Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
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
              name: data.name || file.replace('.toml', ''),
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
        'User-Agent': 'ModListGenerator/1.0.0'
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

  private async getModVersions(projectId: string): Promise<any[]> {
    if (this.versionCache.has(projectId)) {
      return this.versionCache.get(projectId)!;
    }
    
    const cacheFile = join(this.cacheDir, `versions-${projectId}.json`);
    
    try {
      // Try to read from cache
      const cachedData = await readFile(cacheFile, 'utf-8');
      const cache = JSON.parse(cachedData);
      
      // Check if cache is still valid
      if (Date.now() - cache.timestamp < this.cacheMaxAge) {
        this.versionCache.set(projectId, cache.data);
        return cache.data;
      }
    } catch (error) {
      // Cache doesn't exist or is invalid, continue to fetch from API
    }
    
    // Fetch from API
    const response = await fetch(`${this.modrinthApiBase}/project/${projectId}/version`, {
      headers: {
        'User-Agent': 'ModListGenerator/1.0.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch versions: ${response.status} ${response.statusText}`);
    }
    
    const versions: any[] = await response.json();
    
    // Save to cache
    try {
      const cacheData = {
        timestamp: Date.now(),
        data: versions
      };
      await writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      console.warn(`⚠️ Could not write cache for versions of ${projectId}:`, error instanceof Error ? error.message : error);
    }
    
    this.versionCache.set(projectId, versions);
    
    return versions;
  }

  private async enrichModsWithDetails(mods: PackwizMod[]): Promise<EnrichedMod[]> {
    const enrichedMods: EnrichedMod[] = [];
    
    for (const mod of mods) {
      try {
        const projectDetails = await this.getProjectDetails(mod.projectId);
        enrichedMods.push({
          ...mod,
          title: projectDetails.title,
          slug: projectDetails.slug,
          categories: projectDetails.categories || [],
          isDependency: false,
          dependents: [],
          client_side: projectDetails.client_side,
          server_side: projectDetails.server_side
        });
      } catch (error) {
        console.warn(`⚠️ Failed to fetch details for ${mod.name}:`, error instanceof Error ? error.message : error);
        // Add mod with limited info
        enrichedMods.push({
          ...mod,
          title: mod.name,
          slug: mod.projectId,
          categories: [],
          isDependency: false,
          dependents: [],
          client_side: 'unsupported',
          server_side: 'unsupported'
        });
      }
    }
    
    return enrichedMods;
  }

  private async analyzeDependencies(mods: EnrichedMod[]): Promise<EnrichedMod[]> {
    // First, get all versions for each mod
    for (const mod of mods) {
      try {
        await this.getModVersions(mod.projectId);
      } catch (error) {
        console.warn(`⚠️ Failed to fetch versions for ${mod.title}:`, error instanceof Error ? error.message : error);
      }
    }
    
    // Now analyze dependencies
    for (const mod of mods) {
      const versions = this.versionCache.get(mod.projectId) || [];
      
      for (const version of versions) {
        for (const dependency of version.dependencies || []) {
          if (dependency.project_id && dependency.dependency_type === 'required') {
            const dependentMod = mods.find(m => m.projectId === dependency.project_id);
            if (dependentMod) {
              dependentMod.isDependency = true;
              if (!dependentMod.dependents.includes(mod.title)) {
                dependentMod.dependents.push(mod.title);
              }
            }
          }
        }
      }
    }
    
    return mods;
  }

  private getSideInfo(mod: EnrichedMod): string {
    const isClient = mod.client_side === 'required' || mod.client_side === 'optional';
    const isServer = mod.server_side === 'required' || mod.server_side === 'optional';
    
    if (isClient && isServer) return ' (Both)';
    if (isClient) return ' (Client)';
    if (isServer) return ' (Server)';
    return ' (Unknown)';
  }

  private async generateModListMarkdown(mods: EnrichedMod[], projectRoot: string) {
    // Create a map to track which mods we've already included
    const includedMods = new Set<string>();
    
    // Group mods by combined categories
    const combinedCategories = new Map<string, EnrichedMod[]>();
    
    for (const mod of mods) {
      if (includedMods.has(mod.projectId)) continue;
      
      // Create a combined category key
      const categoryKey = mod.categories.length > 0 
        ? mod.categories.sort().join(' & ') 
        : 'uncategorized';
      
      if (!combinedCategories.has(categoryKey)) {
        combinedCategories.set(categoryKey, []);
      }
      
      combinedCategories.get(categoryKey)!.push(mod);
      includedMods.add(mod.projectId);
    }
    
    // Sort categories alphabetically
    const sortedCategories = Array.from(combinedCategories.entries()).sort(([a], [b]) => a.localeCompare(b));
    
    // Generate markdown content
    let markdownContent = '# Mod List\n\n';
    markdownContent += `Total mods: ${mods.length}\n\n`;
    
    // Regular mods
    markdownContent += '## Regular Mods\n\n';
    
    for (const [category, categoryMods] of sortedCategories) {
      const regularMods = categoryMods.filter(mod => !mod.isDependency);
      if (regularMods.length === 0) continue;
      
      const formattedCategory = this.formatCategoryName(category);
      markdownContent += `### ${formattedCategory}\n\n`;
      
      // Sort mods alphabetically
      regularMods.sort((a, b) => a.title.localeCompare(b.title));
      
      for (const mod of regularMods) {
        const sideInfo = this.getSideInfo(mod);
        markdownContent += `- [${mod.title}](https://modrinth.com/mod/${mod.slug})${sideInfo}\n`;
      }
      markdownContent += '\n';
    }
    
    // Dependency mods
    const dependencyMods = mods.filter(mod => mod.isDependency);
    if (dependencyMods.length > 0) {
      markdownContent += '## Dependency Mods\n\n';
      markdownContent += '*These mods are required by other mods in the pack.*\n\n';
      
      // Group dependencies by combined categories
      const dependencyCategories = new Map<string, EnrichedMod[]>();
      const includedDependencies = new Set<string>();
      
      for (const mod of dependencyMods) {
        if (includedDependencies.has(mod.projectId)) continue;
        
        // Create a combined category key
        const categoryKey = mod.categories.length > 0 
          ? mod.categories.sort().join(' & ') 
          : 'uncategorized-dependencies';
        
        if (!dependencyCategories.has(categoryKey)) {
          dependencyCategories.set(categoryKey, []);
        }
        
        dependencyCategories.get(categoryKey)!.push(mod);
        includedDependencies.add(mod.projectId);
      }
      
      // Sort dependency categories alphabetically
      const sortedDependencyCategories = Array.from(dependencyCategories.entries()).sort(([a], [b]) => a.localeCompare(b));
      
      for (const [category, categoryMods] of sortedDependencyCategories) {
        const formattedCategory = this.formatCategoryName(category);
        markdownContent += `### ${formattedCategory}\n\n`;
        
        // Sort mods alphabetically
        categoryMods.sort((a, b) => a.title.localeCompare(b.title));
        
        for (const mod of categoryMods) {
          const sideInfo = this.getSideInfo(mod);
          const dependentsList = mod.dependents.length > 0 
            ? ` *(required by: ${mod.dependents.join(', ')})*` 
            : '';
          markdownContent += `- [${mod.title}](https://modrinth.com/mod/${mod.slug})${sideInfo}${dependentsList}\n`;
        }
        markdownContent += '\n';
      }
    }
    
    // Summary
    markdownContent += '## Summary\n\n';
    markdownContent += `- Total mods: ${mods.length}\n`;
    markdownContent += `- Regular mods: ${mods.filter(mod => !mod.isDependency).length}\n`;
    markdownContent += `- Dependency mods: ${dependencyMods.length}\n`;
    markdownContent += `- Categories: ${sortedCategories.length}\n`;
    
    // Side information legend
    markdownContent += '\n## Side Information Legend\n\n';
    markdownContent += '- **(Client)**: Client-side only mod\n';
    markdownContent += '- **(Server)**: Server-side only mod\n';
    markdownContent += '- **(Both)**: Both client and server side mod\n';
    markdownContent += '- **(Unknown)**: Side information not available\n';
    
    // Write to file
    await writeFile(join(projectRoot, 'MODLIST.md'), markdownContent);
    console.log('📄 Mod list written to MODLIST.md');
  }

  private formatCategoryName(category: string): string {
    if (category === 'uncategorized') return 'Uncategorized';
    if (category === 'uncategorized-dependencies') return 'Uncategorized Dependencies';
    
    return category
      .split(' & ')
      .map(part => part
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '))
      .join(' & ');
  }
}

// Run the application
const generator = new ModListGenerator();
generator.run().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});