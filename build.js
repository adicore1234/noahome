const fs = require('fs');
const path = require('path');

const root = __dirname;
const output = path.join(root, 'dist');

/* Keep the cleanup tightly scoped to this project's generated directory. */
if (path.dirname(output) !== root || path.basename(output) !== 'dist') {
  throw new Error('Refusing to build outside the project dist directory');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of ['index.html', 'site.html', 'site-business.html', 'content.json', 'template.json', 'template-kids.json']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}

for (const directory of ['admin', 'superadmin', 'assets']) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), {
    recursive: true
  });
}

console.log('Pagely built in dist/ (login, site renderer, admin, superadmin and assets)');
