import type { ApiProvider, ProviderResponse } from '../types/index';

interface ManualInputProviderOptions {
  id?: string;
  config?: {
    multiline?: boolean;
  };
}

export class ManualInputProvider implements ApiProvider {
  config: ManualInputProviderOptions['config'];

  constructor(options: ManualInputProviderOptions = {}) {
    this.config = options.config;
    this.id = () => options.id || 'manual-input';
  }

  id() {
    return 'promptfoo:manual-input';
  }

  async callApi(_prompt: string): Promise<ProviderResponse> {
    throw new Error(
      'ManualInputProvider requires interactive input and is not supported in library mode. ' +
        'Use a programmatic provider instead.',
    );
  }
}
