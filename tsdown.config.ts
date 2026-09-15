import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'project-cybersyn-dsh-plugin'

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
  outputOptions: { entryFileNames: '[name].js' },
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-connection/client',
      '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-conversation/client',
      '@deepseek-ai/dsh-client-ui-slots',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const core: UserConfig = {
  entry: { core: 'src/core.ts' }, outDir: 'runtime/lib', format: ['esm'],
  platform: 'node', target: 'es2022', dts: false, clean: true,
  outputOptions: { entryFileNames: '[name].js' },
}

export default defineConfig([host, client, core])
