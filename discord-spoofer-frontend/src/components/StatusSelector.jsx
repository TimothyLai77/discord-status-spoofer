
import { Card } from "@chakra-ui/react"
import { Button } from "@chakra-ui/react"
import { Switch } from "@chakra-ui/react"
import { useEffect, useState } from "react";
import axios from "axios"

const StatusSelector = () => {
    const [status, setStatus] = useState([]);

    const handleButtonClick = async (status) => {
        try{
            const json = {newStatus: status, isAfk: true}
            const reponse = await axios.post('/api/updateStatus', json)
            // lol i give up, wait 250ms for the backend to finish up
            await new Promise((resolve) => setTimeout(resolve, 250)); 
            await fetchData()
        }catch (error){
            console.error(`Error: ${error}`)
        }
    }

    const fetchData = async () => {
        try{
            const response = await axios.get("/api/getStatus")
            const currentStatus = await response.data.currentStatus
            setStatus(currentStatus)
        }catch (error){
                console.error('Error:', error);
                setStatus("error getting status")
        }
    }

    useEffect(() => {

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
