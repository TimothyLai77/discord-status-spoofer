
import { Card } from "@chakra-ui/react"
import { Button, ButtonGroup } from "@chakra-ui/react"
const StatusSelector = () => {
  return (
    <Card.Root>
        <Card.Header />
            <Card.Body>
                <Button>online</Button>
                <Button>away</Button>
                <Button>do not disturb</Button>
                <Button>invisible</Button>

            </Card.Body>
        <Card.Footer />
    </Card.Root>
  );
};

export default StatusSelector
