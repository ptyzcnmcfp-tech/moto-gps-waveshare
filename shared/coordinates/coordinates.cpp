#include "moto_coordinates.hpp"

#include <cmath>

namespace moto::coordinates {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kEarthAxisM = 6378245.0;
constexpr double kEccentricitySquared = 0.006693421622965943;
constexpr double kCoordinateScale = 10000000.0;

double transform_latitude(double longitude_offset,
                          double latitude_offset) noexcept {
  double result = -100.0 + 2.0 * longitude_offset + 3.0 * latitude_offset +
                  0.2 * latitude_offset * latitude_offset +
                  0.1 * longitude_offset * latitude_offset +
                  0.2 * std::sqrt(std::fabs(longitude_offset));

  result += ((20.0 * std::sin(6.0 * longitude_offset * kPi) +
              20.0 * std::sin(2.0 * longitude_offset * kPi)) *
             2.0) /
            3.0;
  result += ((20.0 * std::sin(latitude_offset * kPi) +
              40.0 * std::sin((latitude_offset / 3.0) * kPi)) *
             2.0) /
            3.0;
  result += ((160.0 * std::sin((latitude_offset / 12.0) * kPi) +
              320.0 * std::sin((latitude_offset * kPi) / 30.0)) *
             2.0) /
            3.0;
  return result;
}

double transform_longitude(double longitude_offset,
                           double latitude_offset) noexcept {
  double result = 300.0 + longitude_offset + 2.0 * latitude_offset +
                  0.1 * longitude_offset * longitude_offset +
                  0.1 * longitude_offset * latitude_offset +
                  0.1 * std::sqrt(std::fabs(longitude_offset));

  result += ((20.0 * std::sin(6.0 * longitude_offset * kPi) +
              20.0 * std::sin(2.0 * longitude_offset * kPi)) *
             2.0) /
            3.0;
  result += ((20.0 * std::sin(longitude_offset * kPi) +
              40.0 * std::sin((longitude_offset / 3.0) * kPi)) *
             2.0) /
            3.0;
  result += ((150.0 * std::sin((longitude_offset / 12.0) * kPi) +
              300.0 * std::sin((longitude_offset / 30.0) * kPi)) *
             2.0) /
            3.0;
  return result;
}

double round_coordinate(double value) noexcept {
  return std::round(value * kCoordinateScale) / kCoordinateScale;
}

}  // namespace

bool is_valid_coordinate(Coordinate coordinate) noexcept {
  return std::isfinite(coordinate.longitude_deg) &&
         std::isfinite(coordinate.latitude_deg);
}

bool is_outside_gcj02_coverage(Coordinate coordinate) noexcept {
  const double lon = coordinate.longitude_deg;
  const double lat = coordinate.latitude_deg;
  if (lon < 72.004 || lon > 135.10 || lat < 18.15 || lat > 55.8271) {
    return true;
  }
  // Exclude Korean Peninsula and Japan (Kyushu, Okinawa, Western Honshu)
  // while keeping Liaoning (Dandong ~40.1N) and Shandong/Zhejiang (<123.0E).
  if (lat < 39.8 && lon > 123.2) {
    return true;
  }
  // Exclude Taiwan Island across the Taiwan Strait (Fujian Pingtan <= 119.85E).
  if (lon >= 119.9 && lon <= 122.3 && lat >= 21.8 && lat <= 25.4) {
    return true;
  }
  // Exclude Northern Vietnam / Laos south-west of Guangxi & Yunnan borders
  // while keeping Beihai/Zhanjiang (>=108.0E) and Hainan Island.
  if (lat < 21.45 && lon < 108.0) {
    return true;
  }
  return false;
}

ConversionResult wgs84_to_gcj02(Coordinate coordinate) noexcept {
  if (!is_valid_coordinate(coordinate)) {
    return {coordinate, ConversionStatus::InvalidInput};
  }

  if (is_outside_gcj02_coverage(coordinate)) {
    return {{round_coordinate(coordinate.longitude_deg),
             round_coordinate(coordinate.latitude_deg)},
            ConversionStatus::Ok};
  }

  double latitude_delta =
      transform_latitude(coordinate.longitude_deg - 105.0,
                         coordinate.latitude_deg - 35.0);
  double longitude_delta =
      transform_longitude(coordinate.longitude_deg - 105.0,
                          coordinate.latitude_deg - 35.0);
  const double radian_latitude = coordinate.latitude_deg / 180.0 * kPi;
  double magic = std::sin(radian_latitude);
  magic = 1.0 - kEccentricitySquared * magic * magic;
  const double sqrt_magic = std::sqrt(magic);
  latitude_delta =
      latitude_delta * 180.0 /
      ((kEarthAxisM * (1.0 - kEccentricitySquared) /
        (magic * sqrt_magic)) *
       kPi);
  longitude_delta = longitude_delta * 180.0 /
                    ((kEarthAxisM / sqrt_magic) *
                     std::cos(radian_latitude) * kPi);

  return {{round_coordinate(coordinate.longitude_deg + longitude_delta),
           round_coordinate(coordinate.latitude_deg + latitude_delta)},
          ConversionStatus::Ok};
}

}  // namespace moto::coordinates
