import pyaudio
import json

def get_devices():
    p = pyaudio.PyAudio()
    devices = []
    
    # Let's get APIs as well
    apis = {}
    for i in range(p.get_host_api_count()):
        api_info = p.get_host_api_info_by_index(i)
        apis[api_info["index"]] = api_info["name"]
        
    for i in range(p.get_device_count()):
        dev = p.get_device_info_by_index(i)
        # Add host api name for debugging
        dev["hostApiName"] = apis.get(dev["hostApi"], "Unknown")
        devices.append(dev)
        
    p.terminate()
    with open("devices.json", "w") as f:
        json.dump(devices, f, indent=2)

get_devices()
print("Exported devices")
