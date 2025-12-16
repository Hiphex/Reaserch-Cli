/**
 * Node.js version check utility
 * Ensures the CLI runs on a supported Node.js version
 */

const MIN_NODE_VERSION = 22;

/**
 * Check if the current Node.js version meets minimum requirements.
 * Exits with a helpful error message if not.
 */
export function checkNodeVersion(): void {
    const currentVersion = process.versions.node;
    const majorVersion = parseInt(currentVersion.split('.')[0], 10);

    if (majorVersion < MIN_NODE_VERSION) {
        console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Deep Research CLI requires Node.js ${MIN_NODE_VERSION} or higher              ║
╠══════════════════════════════════════════════════════════════╣
║  Current version: ${currentVersion.padEnd(44)}║
║  Required:        ${MIN_NODE_VERSION}.0.0 or higher${' '.repeat(27)}║
║                                                              ║
║  Please upgrade Node.js: https://nodejs.org                  ║
╚══════════════════════════════════════════════════════════════╝
`);
        process.exit(1);
    }
}
