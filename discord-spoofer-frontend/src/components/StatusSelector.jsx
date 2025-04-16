
import { Card } from "@chakra-ui/react"
import { Button } from "@chakra-ui/react"
import { Switch } from "@chakra-ui/react"
const StatusSelector = () => {
  return (
    <Card.Root>
        <Card.Header>
            Current status: 
        </Card.Header>
        <Card.Body gap="2">
            <Button>online</Button>
            <Button>away</Button>
            <Button>do not disturb</Button>
            <Button>invisible</Button>
        </Card.Body>
        <Card.Footer justifyContent={"left"}>
        <Switch.Root>
        <Switch.HiddenInput />
            <Switch.Control>
                <Switch.Thumb />
            </Switch.Control>
            <Switch.Label> AFK Enabled (enable push notifications) </Switch.Label>
        </Switch.Root>
        </Card.Footer>
    </Card.Root>
  );
};

export default StatusSelector
