console.info("Orbit worker started");

// Durable jobs will be introduced with the first worker feature.
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

export {};
