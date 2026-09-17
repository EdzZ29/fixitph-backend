import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AUTH_THROTTLE } from '../common/throttle';
import type { Request, Response } from 'express';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/types';
import { AuthService, type RequestMeta } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto, VerifyResetCodeDto } from './dto/reset-password.dto';

const REFRESH_COOKIE = 'fixitph_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @Throttle({ auth: AUTH_THROTTLE.register })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.register(dto, meta(req));
    this.setRefreshCookie(res, tokens.refreshToken);
    return {
      userId: tokens.userId,
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: AUTH_THROTTLE.login })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.login(dto, meta(req));
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: AUTH_THROTTLE.refresh })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = this.readRefreshToken(req, dto);
    const tokens = await this.auth.refresh(presented, meta(req));
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented =
      (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ??
      dto.refreshToken;
    await this.auth.logout(presented);
    this.clearRefreshCookie(res);
    return { loggedOut: true };
  }

  /** Step 1. Emails a six digit code. */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: AUTH_THROTTLE.forgotPassword })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const result = await this.passwordReset.request(dto.email, { ip: req.ip });
    // Deliberately identical whether or not the address is registered.
    return {
      message: 'If that email is registered, a six digit code is on its way.',
      ...result,
    };
  }

  /** Step 2. Exchanges the code for a single-use reset token. */
  @Public()
  @Post('verify-reset-code')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: AUTH_THROTTLE.verifyResetCode })
  async verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.passwordReset.verify(dto.email, dto.code);
  }

  /** Step 3. Spends the token and sets the new password. */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: AUTH_THROTTLE.resetPassword })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.passwordReset.reset(dto.resetToken, dto.password);
    this.clearRefreshCookie(res);
    return { message: 'Password updated. Please sign in again.' };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  // -- cookie handling -------------------------------------------------------

  private readRefreshToken(req: Request, dto: RefreshDto): string {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    const token = fromCookie ?? dto.refreshToken;
    if (!token) {
      throw ApiError.unauthenticated(
        'MISSING_REFRESH_TOKEN',
        'Please sign in again.',
      );
    }
    return token;
  }

  /**
   * httpOnly so script on the page cannot read it, sameSite=lax so it is not
   * sent on cross-site form posts, and secure whenever the deployment is not
   * plain localhost.
   */
  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('COOKIE_SECURE') === 'true',
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      path: '/',
      maxAge: 30 * 86_400_000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('COOKIE_SECURE') === 'true',
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      path: '/',
    });
  }
}

function meta(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}
