// Copyright (c) 2021 Mobvoi Inc (Binbin Zhang)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef UTILS_LOG_H_
#define UTILS_LOG_H_

// Because openfst is a dynamic library compiled with gflags/glog, we must use
// the gflags/glog from openfst to avoid them linked both statically and
// dynamically into the executable.
//#include "fst/log.h"
#include <assert.h>
#include <iostream>
//#include <string.h>

#define CHECK(x) assert(x)
#define CHECK_GE(x, y) assert((x) >= (y))
#define WARNING "warning"
#define ERROR "error"
#define INFO "info"

//inline std::ostream& get_logger(const char* logger) {
//    if (strcmp(logger, "warning"))
//        return std::cerr;
//    if (strcmp(logger, "error"))
//        return std::cerr;
//    if (strcmp(logger, "info"))
//        return std::cout;
//}

#define LOG(x) std::cout 

#endif  // UTILS_LOG_H_
