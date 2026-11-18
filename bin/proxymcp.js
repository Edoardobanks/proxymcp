#!/usr/bin/env node

import('../dist/cli.js')
  .then((m) => m.main())
  .catch((err) => {
    console.error('Failed to run proxymcp:', err);
    process.exit(1);
  });
