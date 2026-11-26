// The libs every check needs, named again here: the vendored zenoh-gateway client says no-default-lib, which drops deno.json's lib list from any program that imports it
/// <reference lib="deno.ns" />

// @types/three names GPUTexture, which only TypeScript 6's DOM lib has (Deno 2.5 has 5.9); empty, so it merges with the real one where it exists
interface GPUTexture {}
