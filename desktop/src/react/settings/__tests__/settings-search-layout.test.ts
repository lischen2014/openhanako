import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(pathFromRoot: string) {
  return readFileSync(join(process.cwd(), pathFromRoot), 'utf8');
}

function cssRule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('settings search sidebar layout', () => {
  it('uses a 180px settings navigation rail', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(css).toContain('--settings-nav-width: 180px;');
  });

  it('keeps the modal shell wide enough after expanding the navigation rail', () => {
    const css = readProjectFile('desktop/src/react/components/SettingsModalShell.module.css');

    expect(css).toContain('width: min(884px, calc(100vw - 2 * var(--space-24)));');
  });
});

describe('settings page width contract', () => {
  it('keeps the normal header column capped at 640px, not 1fr', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');
    const header = cssRule(css, '.settings-header-modal');

    expect(header).toMatch(/minmax\(0,\s*640px\)/);
    expect(header).not.toMatch(/minmax\(0,\s*1fr\)/);
  });

  it('keeps normal tab content at a hard 640px max and clips horizontal overflow', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(css).toMatch(
      /\.settings-main\s*>\s*\.settings-tab-content\s*\{[^}]*max-width:\s*640px;[^}]*overflow-x:\s*hidden;/s,
    );
  });

  it('does not mark providers as a wide settings tab', () => {
    const source = readProjectFile('desktop/src/react/settings/SettingsContent.tsx');
    const shell = readProjectFile('desktop/src/react/components/SettingsModalShell.tsx');

    expect(source).toMatch(/isWideTab = effectiveActiveTab === 'plugin-marketplace';/);
    expect(source).not.toMatch(/isWideTab = .*providers/);
    expect(shell).toMatch(/isWideSettingsPage = settingsModal\.activeTab === 'plugin-marketplace';/);
    expect(shell).not.toMatch(/activeTab === 'providers'/);
  });

  it('does not allow the modal card to flex-shrink via min-width: 0', () => {
    const css = readProjectFile('desktop/src/react/components/SettingsModalShell.module.css');
    const card = cssRule(css, '.card');

    expect(card).not.toMatch(/min-width:\s*0;/);
    expect(card).toMatch(/max-width:\s*min\(884px,/);
  });
});
