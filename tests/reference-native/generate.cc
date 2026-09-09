#include <fstream>
#include <iterator>
#include <vector>
#include "frontend/fbank.h"
int main(int argc, char** argv) {
  if (argc != 3) return 1;
  std::ifstream input(argv[1], std::ios::binary);
  std::vector<char> bytes((std::istreambuf_iterator<char>(input)), {});
  std::vector<float> wave(bytes.size()/2);
  for (size_t i=0;i<wave.size();i++) wave[i]=static_cast<short>(static_cast<unsigned char>(bytes[2*i]) | (static_cast<unsigned char>(bytes[2*i+1])<<8));
  wenet::Fbank fbank(80,16000,400,160);
  std::vector<std::vector<float>> features;
  fbank.Compute(wave, &features);
  std::ofstream output(argv[2],std::ios::binary);
  for(const auto& frame:features) output.write(reinterpret_cast<const char*>(frame.data()),frame.size()*sizeof(float));
}
