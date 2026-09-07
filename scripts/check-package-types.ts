// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import ButterSwidgeProtocol, {
  type ButterSwidgeProtocolConfig
} from '@butternetwork/wdk-protocol-swidge-butter'
import type { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'

// @ts-expect-error Version 0.2 removes the wallet-client compatibility type.
import type { EvmWalletClient } from '@butternetwork/wdk-protocol-swidge-butter'
// @ts-expect-error Version 0.2 removes the viem wallet-client compatibility type.
import type { ViemWalletClientLike } from '@butternetwork/wdk-protocol-swidge-butter'

declare const account: WalletAccountEvm

const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk'
})

account.sendTransaction({
  to: '0x1111111111111111111111111111111111111111',
  value: 0n,
  data: '0x1234',
  chainId: 56
})

const configWithoutLegacyWalletClient: ButterSwidgeProtocolConfig = {
  sourceChainId: 56,
  entrance: 'wdk',
  evm: {
    // @ts-expect-error Version 0.2 accepts only the read-only EVM client here.
    walletClient: {}
  }
}

void protocol
void configWithoutLegacyWalletClient
