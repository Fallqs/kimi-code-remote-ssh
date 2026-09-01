import {
  Disposable,
  IShadowHostSupport,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '@moonshot-ai/agent-core-v2';

export class ShadowHostSupportService extends Disposable implements IShadowHostSupport {
  declare readonly _serviceBrand: undefined;
}

registerScopedService(
  LifecycleScope.App,
  IShadowHostSupport,
  ShadowHostSupportService,
  ScopeActivation.OnScopeCreated,
  'shadow',
);
