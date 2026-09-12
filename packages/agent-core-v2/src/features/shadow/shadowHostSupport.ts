import { Disposable } from '#/_base/di/lifecycle';
import {
  getScopedServiceDescriptors,
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import { IShadowHostSupport } from './shadowCoordinator';

export class ShadowHostSupportService extends Disposable implements IShadowHostSupport {
  declare readonly _serviceBrand: undefined;
}

export function registerShadowHostSupport(): void {
  const registered = getScopedServiceDescriptors(LifecycleScope.App).some(
    (entry) => entry.id === IShadowHostSupport,
  );
  if (registered) return;
  registerScopedService(
    LifecycleScope.App,
    IShadowHostSupport,
    ShadowHostSupportService,
    ScopeActivation.OnScopeCreated,
    'shadow',
  );
}
