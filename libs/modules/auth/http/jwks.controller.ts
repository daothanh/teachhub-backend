import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@teachhub/core';
import type { JSONWebKeySet } from 'jose';
import { JwtKeysService } from '../jwt/jwt-keys.service.js';

/** Khóa công khai xác minh access token (RFC 7517), ngoài tiền tố /v1. */
@ApiExcludeController()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly jwt: JwtKeysService) {}

  @Public()
  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks(): JSONWebKeySet {
    return this.jwt.jwks;
  }
}
