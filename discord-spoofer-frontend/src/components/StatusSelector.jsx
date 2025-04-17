
import { Card } from "@chakra-ui/react"
import { Button } from "@chakra-ui/react"
import { Switch } from "@chakra-ui/react"
import { useEffect, useState } from "react";
import axios from "axios"

const StatusSelector = () => {

    const handleButtonClick = async (status) => {
        try{
            const json = {newStatus: status, isAfk: true}
            const reponse = await axios.post('http://127.0.0.1:8081/api/updateStatus', json)
        }catch (error){
            console.error(`Error: ${error}`)
        }
    }

    const [status, setStatus] = useState([]);

    useEffect(() => {
        const fetchData = async () => {
            try{
                // todo: chnage this to use axios
                const response = await fetch('http://127.0.0.1:8081/api/getStatus')
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
            <Button onClick={() => handleButtonClick("online")}>online</Button>
            <Button onClick={() => handleButtonClick("away")}>away</Button>
            <Button onClick={() => handleButtonClick("dnd")}>do not disturb</Button>
            <Button onClick={() => handleButtonClick("invisible")}>invisible</Button>
        </Card.Body>
        <Card.Footer justifyContent={"left"}>
        <Switch.Root>
        <Switch.HiddenInput />
            <Switch.Control>
                <Switch.Thumb />
            </Switch.Control>
            <Switch.Label> AFK Enabled (enable push notifications) (also non functional, all updates will be set with isAFK=true) </Switch.Label>
        </Switch.Root>
        </Card.Footer>
    </Card.Root>
  );
};

export default StatusSelector
