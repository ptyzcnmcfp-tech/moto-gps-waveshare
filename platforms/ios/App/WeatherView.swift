import SwiftUI

struct WeatherView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                if let weather = model.weather {
                    currentSection(weather)
                    next24HoursSection(weather)
                    next7DaysSection(weather)
                } else if model.isLoadingWeather {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("正在获取天气…")
                        }
                        .padding(.vertical, 8)
                    }
                } else {
                    Section {
                        Text(model.weatherFailure ?? "暂无天气数据")
                            .foregroundStyle(.secondary)
                        Button("刷新天气", action: model.refreshWeather)
                        if model.weatherFailure?.contains("定位") == true {
                            Button("打开系统设置", action: openSystemSettings)
                        }
                    }
                }
            }
            .navigationTitle("天气")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .onAppear {
            if model.weather == nil { model.refreshWeather() }
        }
    }

    private func currentSection(_ weather: WeatherForecast) -> some View {
        Section {
            VStack(spacing: 10) {
                Image(systemName: weatherSymbol(weather.currentWeatherCode))
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(.blue)
                Text("\(Int(round(weather.currentTemperature)))°")
                    .font(.system(size: 40, weight: .semibold))
                Text(weatherCondition(weather.currentWeatherCode))
                    .foregroundStyle(.secondary)
                Text("当前降水概率 \(weather.currentPrecipitationProbability)%")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .listRowBackground(Color.clear)
    }

    private func next24HoursSection(_ weather: WeatherForecast) -> some View {
        Section("未来 24 小时降水") {
            if weather.next24Hours.isEmpty {
                Text("暂无逐小时预报")
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(weather.next24Hours) { hour in
                            VStack(spacing: 8) {
                                Text(hour.hourLabel)
                                    .font(.subheadline)
                                Image(systemName: weatherSymbol(hour.weatherCode))
                                    .foregroundStyle(.blue)
                                Text("\(Int(round(hour.temperature)))°")
                                Text("\(hour.precipitationProbability)%")
                                    .font(.caption)
                                    .foregroundStyle(hour.precipitationProbability >= 50 ? .orange : .secondary)
                            }
                            .frame(width: 68)
                            .padding(.vertical, 10)
                            .background(Color(uiColor: .secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    private func next7DaysSection(_ weather: WeatherForecast) -> some View {
        Section("未来 7 天") {
            ForEach(weather.next7Days) { day in
                HStack {
                    Text(day.dayLabel)
                        .frame(width: 56, alignment: .leading)
                    Image(systemName: weatherSymbol(day.weatherCode))
                        .foregroundStyle(.blue)
                    Text(weatherCondition(day.weatherCode))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("降水 \(day.precipitationProbability)%")
                        .foregroundStyle(.secondary)
                    Text("\(Int(round(day.lowTemperature)))° / \(Int(round(day.highTemperature)))°")
                        .frame(width: 76, alignment: .trailing)
                }
            }
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

private func weatherCondition(_ code: Int) -> String {
    switch code {
    case 0: return "晴"
    case 1: return "大致晴朗"
    case 2: return "多云"
    case 3: return "阴"
    case 45, 48: return "雾"
    case 51, 53, 55, 56, 57: return "毛毛雨"
    case 61, 63, 65, 66, 67: return "雨"
    case 71, 73, 75, 77, 85, 86: return "雪"
    case 80, 81, 82: return "阵雨"
    case 95, 96, 99: return "雷暴"
    default: return "未知"
    }
}

private func weatherSymbol(_ code: Int) -> String {
    switch code {
    case 0: return "sun.max.fill"
    case 1, 2: return "cloud.sun"
    case 3: return "cloud"
    case 45, 48: return "fog"
    case 51, 53, 55, 56, 57, 80, 81, 82: return "cloud.drizzle"
    case 61, 63, 65, 66, 67: return "cloud.rain"
    case 71, 73, 75, 77, 85, 86: return "cloud.snow"
    case 95, 96, 99: return "cloud.bolt"
    default: return "questionmark"
    }
}
