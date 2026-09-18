import { Matches } from 'class-validator';

export class ConfirmEmailDto {
  /**
   * Six digits. Matched strictly so a code with spaces or dashes pasted from
   * the email is rejected here with a clear message, rather than burning one
   * of the caller's limited attempts on a value that was never going to match.
   */
  @Matches(/^\d{6}$/, {
    message: 'The code is six digits.',
  })
  code!: string;
}
