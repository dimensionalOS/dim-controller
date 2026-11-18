// The page's URL options (core/urlOptions.ts): ?robot=<type> and ?onboarding=off; anything else changes nothing.
import { assertEquals } from "jsr:@std/assert@1"
import { readUrlOptions } from "../src/core/urlOptions.ts"

Deno.test("url options: a known robot type and onboarding=off; unknown values are ignored", () => {
    assertEquals(readUrlOptions("?robot=arm&onboarding=off"), { robot: "arm", onboardingOff: true })
    assertEquals(readUrlOptions("?robot=car&onboarding=no"), { robot: null, onboardingOff: false })
    assertEquals(readUrlOptions(""), { robot: null, onboardingOff: false })
})
