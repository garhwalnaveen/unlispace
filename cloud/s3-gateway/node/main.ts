import { ingressDeps, ingressServer } from "./ingress";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const deps = ingressDeps({
  bridgeUrl: required("ULS_INGRESS_BRIDGE_URL"), dataPlaneUrl: required("ULS_DATA_PLANE_URL"),
  secret: required("ULS_INGRESS_SECRET"), host: required("ULS_S3_HOST"), issuer: required("ULS_ISSUER"),
  signingKey: JSON.parse(required("ULS_JWT_PRIVATE_JWK")),
});
const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const protocol = process.env.ULS_INGRESS_PROTOCOL ?? "https";
if (protocol !== "http" && protocol !== "https") throw new Error("Invalid ULS_INGRESS_PROTOCOL");
const server = ingressServer(deps, protocol);
server.listen(port, process.env.ULS_LISTEN_HOST ?? "127.0.0.1", () => console.log(`S3 streaming ingress listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
