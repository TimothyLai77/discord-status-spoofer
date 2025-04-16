
import { Card } from "@chakra-ui/react"
import { Button } from "@chakra-ui/react"
import { Switch } from "@chakra-ui/react"
import { useEffect, useState } from "react";
const StatusSelector = () => {
    const [status, setStatus] = useState([]);

    useEffect(() => {
        const fetchData = async () => {
            try{
                const response = await fetch('http://127.0.0.1:8081/getStatus')
                const result = await response.json()
                const currentStatus = result.currentStatus
                setStatus(currentStatus)
            }catch (error){
                 console.error('Error:', error);
                 setStatus("error getting status")
            }
        }
        fetchData()
    }, []);

  return (
    <Card.Root>
        <Card.Header>
            Current status: {status}
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
