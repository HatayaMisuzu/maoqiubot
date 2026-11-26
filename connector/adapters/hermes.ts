import {Acp} from './acp.ts'

export class Hermes extends Acp {
  protected override readonly expectedAgent='hermes-agent'
  // Hermes may apply the requested cwd when loading a session. Check its existing scope first.
  protected override readonly verifySessionScope=true
  // A cold ACP session starts the Hermes gateway and reads the model inventory.
  protected override readonly sessionSetupTimeout=120_000
}
