export interface AlysiaConfig {
  bot: {
    name: string;
    ownerId: string;
  };
  llm: {
    primary: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
    embedding: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };
  server: {
    port: number;
  };
}
