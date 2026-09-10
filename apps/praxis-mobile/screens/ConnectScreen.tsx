import React from 'react';
import { Body, Button, Card, H1, Screen } from '../app/ui';
import { useStore } from '../app/store';

export function ConnectScreen(): React.JSX.Element {
  const { shell, host, connect } = useStore();
  const connecting = shell.connection === 'connecting';

  return (
    <Screen>
      <H1>Praxis</H1>
      <Card>
        <Body>Continue and act on work running on your desktop host.</Body>
        <Body dim>
          Pair once with a QR code from the desktop; after that the phone finds the host on your network and connects over an
          encrypted channel.
        </Body>
      </Card>
      <Card>
        <Body>{host.hostName}</Body>
        <Body dim>{connecting ? 'Connecting…' : 'Demo host · not yet paired'}</Body>
        <Button label={connecting ? 'Connecting…' : 'Connect (demo)'} onPress={connect} />
      </Card>
    </Screen>
  );
}
