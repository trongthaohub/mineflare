import type {
    MinecraftContainer
} from "../container";
import {
    getContainer
} from "@cloudflare/containers";
import {
    env
} from "cloudflare:workers";

export function getMinecraftContainer() {
    return getContainer(env.MINECRAFT_CONTAINER as unknown as DurableObjectNamespace<MinecraftContainer>);
  }
  