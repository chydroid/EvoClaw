---
name: weather-reporter
version: 1.2.0
description: Fetch and report weather information for any location
author: EvoClaw Team
triggers:
  - type: keyword
    pattern: "weather|temperature|forecast"
    description: Triggers when user asks about weather conditions
  - type: intent
    pattern: "check_weather"
    description: Direct weather lookup intent
requires:
  - name: weather-api
    version: ">=2.0.0"
  - name: geo-locator
    version: "*"
    optional: true
config:
  apiEndpoint: "https://api.weather.com"
  units: "metric"
---

## Instructions

To fetch weather data, call the weather API with location parameters:

1. Detect the user's location from the query or context
2. Query the weather API with the detected location
3. Format the weather results for clean display
4. Handle errors gracefully (e.g., invalid location, API timeout)

Always confirm the location with the user before making API calls.

## Scripts

```typescript
export async function fetchWeather(location: string): Promise<WeatherData> {
  const api = getConfig("apiEndpoint");
  const units = getConfig("units") || "metric";
  
  const response = await fetch(`${api}/current?q=${encodeURIComponent(location)}&units=${units}`);
  
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    location: data.location.name,
    temperature: data.current.temp_c,
    condition: data.current.condition.text,
    humidity: data.current.humidity,
    windSpeed: data.current.wind_kph,
  };
}
```

```bash
#!/bin/bash
echo "Installing weather skill dependencies..."
npm install axios
```

## Examples

User: "What's the weather in Tokyo?"
Assistant: I'll check the current weather in Tokyo for you.
[fetches data]
The current weather in Tokyo is 22°C with partly cloudy skies. Humidity is at 65% with light winds at 12 km/h.

User: "Is it going to rain in London tomorrow?"
Assistant: Let me look up the forecast for London.
[fetches data]
Tomorrow's forecast for London shows a 70% chance of rain with a high of 15°C and low of 9°C. You might want to bring an umbrella!