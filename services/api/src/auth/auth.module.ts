import { Module } from "@nestjs/common";

import { JwksVerifier } from "./jwks-verifier.js";

@Module({
  providers: [JwksVerifier],
  exports: [JwksVerifier],
})
export class AuthModule {}
