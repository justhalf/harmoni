import pyaudio
import json

def test_dedup():
    p = pyaudio.PyAudio()
    host_apis = {}
    for i in range(p.get_host_api_count()):
        try:
            api_info = p.get_host_api_info_by_index(i)
            host_apis[api_info["index"]] = api_info["name"]
        except:
            pass

    api_scores = {
        "Windows WASAPI": 3,
        "Windows DirectSound": 2,
        "MME": 1,
        "Windows WDM-KS": -1
    }

    unique_devices = {}
    for i in range(p.get_device_count()):
        try:
            dev = p.get_device_info_by_index(i)
            if dev.get('maxInputChannels', 0) > 0:
                api_index = dev.get('hostApi')
                api_name = host_apis.get(api_index, "Unknown")
                score = api_scores.get(api_name, 0)
                
                if score < 0:
                    continue
                    
                name = dev.get('name')
                group_key = name[:31]
                
                if group_key not in unique_devices or score > unique_devices[group_key]['score']:
                    unique_devices[group_key] = {
                        "index": i,
                        "name": f"{name} ({api_name})" if api_name != "Unknown" else name,
                        "channels": dev.get('maxInputChannels'),
                        "defaultSampleRate": dev.get('defaultSampleRate'),
                        "score": score
                    }
        except Exception as e:
            pass
            
    p.terminate()
    devices = list(unique_devices.values())
    devices.sort(key=lambda x: x["index"])
    
    with open("devices_dedup.json", "w") as f:
        json.dump(devices, f, indent=2)

test_dedup()
print("Exported deduplicated devices")
