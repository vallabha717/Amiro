// adapter/src/routes/index.mjs -- route wire-up entry point for Worker 2.

import * as admin from './admin.mjs';
import * as archive from './archive.mjs';
import * as checkpoint from './checkpoint.mjs';
import * as exportRoutes from './export.mjs';
import * as github from './github.mjs';
import * as mcp from './mcp.mjs';
import * as searchProviders from './search-providers.mjs';
import * as skills from './skills.mjs';
import * as storage from './storage.mjs';
import * as user from './user.mjs';
import * as workspaceTrust from './workspace-trust.mjs';
import * as providerLogin from './provider-login.mjs';
import * as fsbrowse from './fsbrowse.mjs';
import * as providersCatalog from './providers-catalog.mjs';
import * as agent from './agent.mjs';

export function registerRoutes(app, ctx) {
  admin.register(app, ctx);
  archive.register(app, ctx);
  checkpoint.register(app, ctx);
  exportRoutes.register(app, ctx);
  github.register(app, ctx);
  mcp.register(app, ctx);
  searchProviders.register(app, ctx);
  skills.register(app, ctx);
  storage.register(app, ctx);
  user.register(app, ctx);
  workspaceTrust.register(app, ctx);
  providerLogin.register(app, ctx);
  fsbrowse.register(app, ctx);
  providersCatalog.register(app, ctx);
  agent.register(app, ctx);
}
