import {
  DataSourceConnection,
  DataSourcePath,
  RemoteReltabConnection,
  RequestHandler,
  serverInit,
  TransportClient,
  TransportServer,
  registerProvider,
} from "../src/reltab";

test("remote connection forwards interrupt and dataset info", async () => {
  const interrupt = jest.fn(async () => {});
  const getDatasetInfo = jest.fn(async () => ({
    sourceSizeBytes: 1234,
    memorySizeBytes: 5678,
  }));
  const sourceId = {
    providerName: "duckdb" as const,
    resourceId: "remote-method-test",
  };
  const connection = {
    sourceId,
    interrupt,
    getDatasetInfo,
  } as unknown as DataSourceConnection;

  registerProvider({
    providerName: "duckdb",
    connect: async () => connection,
  });

  const handlers = new Map<string, RequestHandler>();
  const server: TransportServer = {
    registerInvokeHandler: (name, handler) => handlers.set(name, handler),
  };
  serverInit(server);

  const client: TransportClient = {
    invoke: async (name, req) => {
      const handler = handlers.get(name);
      if (handler === undefined) {
        throw new Error(`missing handler ${name}`);
      }
      return handler(req);
    },
  };
  const remote = await new RemoteReltabConnection(client).connect(sourceId);
  const path: DataSourcePath = { sourceId, path: ["fixture"] };

  await remote.interrupt();
  expect(interrupt).toHaveBeenCalledTimes(1);

  await expect(remote.getDatasetInfo(path)).resolves.toEqual({
    sourceSizeBytes: 1234,
    memorySizeBytes: 5678,
  });
  expect(getDatasetInfo).toHaveBeenCalledWith(path);
});
