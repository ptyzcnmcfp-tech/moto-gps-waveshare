import Foundation
import MotoNavigationCore

struct WeatherHourForecast: Identifiable, Equatable, Sendable {
    let id: Int
    let timeString: String
    let hourLabel: String
    let temperature: Double
    let precipitationProbability: Int
    let weatherCode: Int
}

struct WeatherDayForecast: Identifiable, Equatable, Sendable {
    let id: String
    let dateString: String
    let dayLabel: String
    let highTemperature: Double
    let lowTemperature: Double
    let precipitationProbability: Int
    let weatherCode: Int
}

struct WeatherForecast: Equatable, Sendable {
    let currentTemperature: Double
    let currentPrecipitationProbability: Int
    let currentWeatherCode: Int
    let next24Hours: [WeatherHourForecast]
    let next7Days: [WeatherDayForecast]
}

enum WeatherServiceError: Error, Equatable {
    case missingLocation
    case invalidResponse
    case networkFailure(String)
}

private struct OpenMeteoEnvelope: Decodable {
    let current: Current?
    let hourly: Hourly?
    let daily: Daily?

    struct Current: Decodable {
        let temperature_2m: Double?
        let precipitation_probability: Int?
        let weather_code: Int?
    }

    struct Hourly: Decodable {
        let time: [String]?
        let precipitation_probability: [Int?]?
        let temperature_2m: [Double?]?
        let weather_code: [Int?]?
    }

    struct Daily: Decodable {
        let time: [String]?
        let temperature_2m_max: [Double?]?
        let temperature_2m_min: [Double?]?
        let precipitation_probability_max: [Int?]?
        let weather_code: [Int?]?
    }
}

final class OpenMeteoWeatherService: @unchecked Sendable {
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetchForecast(for point: WGS84Point?) async throws -> WeatherForecast {
        guard let point, point.isValid else { throw WeatherServiceError.missingLocation }

        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.open-meteo.com"
        components.path = "/v1/forecast"
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.7f", point.latitudeDeg)),
            URLQueryItem(name: "longitude", value: String(format: "%.7f", point.longitudeDeg)),
            URLQueryItem(name: "current",
                         value: "temperature_2m,precipitation_probability,weather_code"),
            URLQueryItem(name: "hourly",
                         value: "precipitation_probability,temperature_2m,weather_code"),
            URLQueryItem(name: "daily",
                         value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
            URLQueryItem(name: "timezone", value: "Asia/Shanghai"),
            URLQueryItem(name: "forecast_days", value: "7")
        ]
        guard let url = components.url else { throw WeatherServiceError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200 ..< 300).contains(http.statusCode) else {
                throw WeatherServiceError.invalidResponse
            }
            let envelope = try decoder.decode(OpenMeteoEnvelope.self, from: data)
            return try Self.mapEnvelope(envelope)
        } catch let error as WeatherServiceError {
            throw error
        } catch {
            throw WeatherServiceError.networkFailure(error.localizedDescription)
        }
    }

    private static func mapEnvelope(_ envelope: OpenMeteoEnvelope) throws -> WeatherForecast {
        guard let current = envelope.current,
              let temperature = current.temperature_2m,
              let weatherCode = current.weather_code else {
            throw WeatherServiceError.invalidResponse
        }

        let hours = mapHours(envelope.hourly)
        let days = mapDays(envelope.daily)
        guard !hours.isEmpty || !days.isEmpty else { throw WeatherServiceError.invalidResponse }

        return WeatherForecast(
            currentTemperature: temperature,
            currentPrecipitationProbability: current.precipitation_probability ?? 0,
            currentWeatherCode: weatherCode,
            next24Hours: Array(hours.prefix(24)),
            next7Days: days)
    }

    private static func mapHours(_ hourly: OpenMeteoEnvelope.Hourly?) -> [WeatherHourForecast] {
        guard let hourly, let times = hourly.time else { return [] }
        let probabilities = hourly.precipitation_probability ?? []
        let temperatures = hourly.temperature_2m ?? []
        let codes = hourly.weather_code ?? []

        let timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let now = Date()
        let currentHour = calendar.date(
            bySettingHour: calendar.component(.hour, from: now),
            minute: 0,
            second: 0,
            of: now) ?? now
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "zh_CN")
        parser.dateFormat = "yyyy-MM-dd'T'HH:mm"
        parser.timeZone = timeZone

        return times.enumerated().compactMap { index, time in
            guard index < temperatures.count,
                  let temperature = temperatures[index],
                  let hourDate = parser.date(from: time),
                  hourDate >= currentHour
            else { return nil }
            let probability = index < probabilities.count ? (probabilities[index] ?? 0) : 0
            let code = index < codes.count ? (codes[index] ?? 0) : 0
            return WeatherHourForecast(
                id: index,
                timeString: time,
                hourLabel: hourLabel(from: time),
                temperature: temperature,
                precipitationProbability: probability,
                weatherCode: code)
        }
    }

    private static func mapDays(_ daily: OpenMeteoEnvelope.Daily?) -> [WeatherDayForecast] {
        guard let daily, let times = daily.time else { return [] }
        let highs = daily.temperature_2m_max ?? []
        let lows = daily.temperature_2m_min ?? []
        let probabilities = daily.precipitation_probability_max ?? []
        let codes = daily.weather_code ?? []
        return times.enumerated().compactMap { index, date in
            guard index < highs.count, let high = highs[index],
                  index < lows.count, let low = lows[index] else { return nil }
            let probability = index < probabilities.count ? (probabilities[index] ?? 0) : 0
            let code = index < codes.count ? (codes[index] ?? 0) : 0
            return WeatherDayForecast(
                id: date,
                dateString: date,
                dayLabel: dayLabel(from: date, index: index),
                highTemperature: high,
                lowTemperature: low,
                precipitationProbability: probability,
                weatherCode: code)
        }
    }

    private static func hourLabel(from timeString: String) -> String {
        let parts = timeString.split(separator: "T")
        guard parts.count == 2 else { return timeString }
        return String(parts[1].prefix(2)) + ":00"
    }

    private static func dayLabel(from dateString: String, index: Int) -> String {
        if index == 0 { return "今天" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        guard let date = formatter.date(from: dateString) else { return dateString }
        formatter.dateFormat = "M月d日"
        return formatter.string(from: date)
    }
}
